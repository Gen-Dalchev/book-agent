import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importEpubData } from '../src/import-epub.js';
import { splitBlocks } from '../src/refs.js';
import { buildEpub, xhtml } from './helpers/epub-builder.js';

// Сноски, чей текст лежит в другом файле книги (#26): отдельный файл примечаний
// в конце, по файлу на главу, EPUB 3 endnotes. Тексты — свои.

const NOTES = 'примечания — разнесены по частям';

let tmp;
let count = 0;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'book-agent-endnotes-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/**
 * @param {{href: string, body: string, linear?: false}[]} docs в порядке чтения
 * @returns {Promise<{index: string, parts: Record<string, string>, skipped: string[]}>}
 */
async function importBook(docs, { all = false } = {}) {
  const items = docs.map((doc, i) => ({ id: `d${i}`, href: doc.href, content: xhtml(doc.body) }));
  const spine = docs.map((doc, i) => (doc.linear === false ? { id: `d${i}`, linear: 'no' } : `d${i}`));
  const data = await buildEpub({ title: 'Книга со сносками в другом файле', author: 'Автор', language: 'ru', items, spine });
  const out = path.join(tmp, `book-${count++}`);
  await importEpubData(data, out, { all });
  const index = await readFile(path.join(out, 'book.md'), 'utf8');
  const parts = {};
  for (const name of (await readdir(path.join(out, 'parts'))).sort()) {
    parts[name.replace(/\.md$/, '')] = await readFile(path.join(out, 'parts', name), 'utf8');
  }
  const start = index.indexOf('## Пропущено');
  const skipped = start === -1 ? []
    : index.slice(start).split('\n').filter((line) => line.startsWith('| ')).slice(2);
  return { index, parts, skipped };
}

test('Calibre: файл «Примечания» в конце — определения в частях глав, сам файл в «Пропущено»', async () => {
  const { index, parts, skipped } = await importBook([
    { href: 'c1.xhtml', body: '<h1>Первая</h1><p>Слово<sup><a href="notes.xhtml#n1" id="r1">1</a></sup> дальше.</p>' },
    { href: 'c2.xhtml', body: '<h1>Вторая</h1><p>Другое<sup><a href="notes.xhtml#n2" id="r2">2</a></sup> слово.</p>' },
    { href: 'notes.xhtml', body: `
      <h1>Примечания</h1>
      <p id="n1"><a href="c1.xhtml#r1">1</a> Текст первой.</p>
      <p id="n2"><a href="c2.xhtml#r2">2</a> Текст <em>второй</em>.</p>` },
  ]);
  assert.deepEqual(parts, {
    '001': '# Первая\n\nСлово[^1] дальше.\n\n[^1]: Текст первой.\n',
    '002': '# Вторая\n\nДругое[^1] слово.\n\n[^1]: Текст *второй*.\n',
  });
  assert.match(index, /^- Глав: 2\n- Частей: 2\n- Сносок: 2$/m);
  assert.deepEqual(skipped, [`| OEBPS/notes.xhtml | Примечания | ${NOTES} |`]);
});

test('EPUB 3: noteref и endnotes без заголовка — файл в «Пропущено», первые слова — до вырезания', async () => {
  const { index, parts, skipped } = await importBook([
    { href: 'c1.xhtml', body: '<h1>Глава</h1><p>Слово<a epub:type="noteref" href="endnotes.xhtml#en1" id="ref1">1</a> дальше.</p>' },
    { href: 'endnotes.xhtml', body: `
      <section epub:type="endnotes"><ol>
        <li id="en1"><p>Текст сноски. <a epub:type="backlink" href="c1.xhtml#ref1">↩</a></p></li>
      </ol></section>` },
  ]);
  assert.deepEqual(parts, { '001': '# Глава\n\nСлово[^1] дальше.\n\n[^1]: Текст сноски.\n' });
  assert.match(index, /^- Глав: 1\n- Частей: 1\n- Сносок: 1$/m);
  assert.deepEqual(skipped, [`| OEBPS/endnotes.xhtml | 1. Текст сноски. ↩ | ${NOTES} |`]);
});

test('ссылка внутри примечания в файле примечаний не разбирается — то примечание достаётся своей главе', async () => {
  const { parts, skipped } = await importBook([
    { href: 'c1.xhtml', body: '<h1>Первая</h1><p>Раз<sup><a href="notes.xhtml#n1">1</a></sup>.</p>' },
    { href: 'c2.xhtml', body: '<h1>Вторая</h1><p>Два<sup><a href="notes.xhtml#n2">2</a></sup>.</p>' },
    { href: 'notes.xhtml', body: `
      <h2>Примечания</h2>
      <p id="n1">1 Первая, см.<sup><a href="#n2">2</a></sup></p>
      <p id="n2">2 Вторая.</p>` },
  ]);
  assert.deepEqual(parts, {
    '001': '# Первая\n\nРаз[^1].\n\n[^1]: Первая, см.2\n',
    '002': '# Вторая\n\nДва[^1].\n\n[^1]: Вторая.\n',
  });
  assert.deepEqual(skipped, [`| OEBPS/notes.xhtml | Примечания | ${NOTES} |`]);
});

test('якорь абзаца главы без обратной ссылки — не сноска: абзац и ¶ на месте; с обратной ссылкой — сноска', async () => {
  const comments = { href: 'comments.xhtml', body: `
    <h1>Комментарии</h1>
    <p>Про абзац<sup><a href="c3.xhtml#p45" id="r45">45</a></sup> — пояснение.</p>` };

  const plain = await importBook([
    { href: 'c3.xhtml', body: '<h1>Глава</h1><p><a id="p45"></a>Абзац главы.</p><p>Второй.</p>' },
    comments,
  ]);
  assert.deepEqual(plain.parts, {
    '001': '# Глава\n\nАбзац главы.\n\nВторой.\n',
    '002': '# Комментарии\n\nПро абзац45 — пояснение.\n',
  });
  const numbered = splitBlocks(plain.parts['001']).filter((block) => block.kind === 'paragraph');
  assert.deepEqual(numbered.map((block) => block.number), [1, 2]);
  assert.deepEqual(plain.skipped, []);

  const linked = await importBook([
    { href: 'c3.xhtml', body: `
      <h1>Глава</h1>
      <p>Первый.</p>
      <p><a id="p45"></a>Это примечание. <a href="comments.xhtml#r45">↩</a></p>` },
    comments,
  ]);
  assert.deepEqual(linked.parts, {
    '001': '# Глава\n\nПервый.\n',
    '002': '# Комментарии\n\nПро абзац[^1] — пояснение.\n\n[^1]: Это примечание.\n',
  });
});

test('страница «Часть первая» из одного заголовка — по-прежнему часть', async () => {
  const { index, parts, skipped } = await importBook([
    { href: 'part1.xhtml', body: '<h1>Часть первая</h1>' },
    { href: 'c1.xhtml', body: '<h1>Глава</h1><p>Слово<sup><a href="notes.xhtml#n1">1</a></sup>.</p>' },
    { href: 'notes.xhtml', body: '<h1>Примечания</h1><p id="n1">Сноска.</p>' },
  ]);
  assert.deepEqual(parts, {
    '001': '# Часть первая\n',
    '002': '# Глава\n\nСлово[^1].\n\n[^1]: Сноска.\n',
  });
  assert.match(index, /^- Глав: 2$/m);
  assert.deepEqual(skipped, [`| OEBPS/notes.xhtml | Примечания | ${NOTES} |`]);
});

test('сноска в заголовке главы в другой файл: метка в «#», в book.md без неё, определение в первой части', async () => {
  const { index, parts } = await importBook([
    { href: 'c1.xhtml', body: `
      <h1>Глава<sup><a href="notes.xhtml#n1">1</a></sup></h1>
      <h2>Раз</h2><p>А.</p>
      <h2>Два</h2><p>Б.</p>` },
    { href: 'notes.xhtml', body: '<p id="n1">Про заголовок.</p>' },
  ]);
  assert.deepEqual(parts, {
    '001-01': '# Глава[^1]\n\n## Раз\n\nА.\n\n[^1]: Про заголовок.\n',
    '001-02': '## Два\n\nБ.\n',
  });
  assert.match(index, /^\| 001 \| Глава \| — \| \d+ \|$/m);
  assert.doesNotMatch(index, /\[\^/);
  assert.match(index, /^- Сносок: 1$/m);
});

test('путь с подпапкой: «../Text/notes.xhtml#id» и «notes.xhtml#id» из соседнего файла', async () => {
  const { parts, skipped } = await importBook([
    { href: 'Text/c1.xhtml', body: '<p>Раз<sup><a href="../Text/notes.xhtml#n1">1</a></sup>.</p>' },
    { href: 'Text/c2.xhtml', body: '<p>Два<sup><a href="notes.xhtml#n%32">2</a></sup>.</p>' },
    { href: 'Text/notes.xhtml', body: '<p id="n1">Первая.</p><p id="n2">Вторая.</p>' },
  ]);
  assert.deepEqual(parts, {
    '001': 'Раз[^1].\n\n[^1]: Первая.\n',
    '002': 'Два[^1].\n\n[^1]: Вторая.\n',
  });
  assert.deepEqual(skipped, [`| OEBPS/Text/notes.xhtml | Первая. | ${NOTES} |`]);
});

test('файл примечаний linear="no" и перед главами в порядке чтения — так же', async () => {
  const { parts, skipped } = await importBook([
    { href: 'notes.xhtml', body: '<h1>Примечания</h1><aside id="n1"><p>Сноска.</p></aside>', linear: false },
    { href: 'c1.xhtml', body: '<h1>Глава</h1><p>Слово<sup><a href="notes.xhtml#n1">1</a></sup>.</p>' },
  ]);
  assert.deepEqual(parts, { '001': '# Глава\n\nСлово[^1].\n\n[^1]: Сноска.\n' });
  assert.deepEqual(skipped, [`| OEBPS/notes.xhtml | Примечания | ${NOTES} |`]);
});

test('одно примечание из двух глав — в каждой своё определение; свой файл и другой — одна нумерация', async () => {
  const { index, parts } = await importBook([
    { href: 'c1.xhtml', body: `
      <p>А<sup><a href="notes.xhtml#n1">*</a></sup> Б<sup><a href="#own">1</a></sup>.</p>
      <p id="own">1 Своя.</p>` },
    { href: 'c2.xhtml', body: '<p>В<sup><a href="notes.xhtml#n1">*</a></sup>.</p>' },
    { href: 'notes.xhtml', body: '<p id="n1">* Общая.</p>' },
  ]);
  assert.deepEqual(parts, {
    '001': 'А[^1] Б[^2].\n\n[^1]: Общая.\n[^2]: Своя.\n',
    '002': 'В[^1].\n\n[^1]: Общая.\n',
  });
  assert.match(index, /^- Сносок: 3$/m);
});

test('в файле примечаний остался текст без ссылок — файл остаётся главой с ним', async () => {
  const { index, parts, skipped } = await importBook([
    { href: 'c1.xhtml', body: '<h1>Глава</h1><p>Слово<sup><a href="notes.xhtml#n1">1</a></sup>.</p>' },
    { href: 'notes.xhtml', body: `
      <h1>Примечания</h1>
      <p id="n1">Связанная.</p>
      <p>Комментарий переводчика без ссылок.</p>` },
  ]);
  assert.deepEqual(parts, {
    '001': '# Глава\n\nСлово[^1].\n\n[^1]: Связанная.\n',
    '002': '# Примечания\n\nКомментарий переводчика без ссылок.\n',
  });
  assert.match(index, /^- Глав: 2$/m);
  assert.deepEqual(skipped, []);
});

test('ссылка на заголовок другой главы, без «#» и в служебную страницу — не сноски', async () => {
  const { parts, skipped } = await importBook([
    { href: 'rights.xhtml', body: '<p id="c1">© Автор, 2026. ISBN 978-0-306-40615-7. Все права защищены.</p>' },
    { href: 'c1.xhtml', body: `
      <p>Раз<sup><a href="c2.xhtml#ch2">2</a></sup>, два<sup><a href="c2.xhtml">3</a></sup>,
        три<sup><a href="rights.xhtml#c1">4</a></sup>.</p>` },
    { href: 'c2.xhtml', body: '<section id="ch2"><h1>Вторая</h1><p>Текст.</p></section>' },
  ]);
  assert.deepEqual(parts, {
    '001': 'Раз2, два3, три4.\n',
    '002': '# Вторая\n\nТекст.\n',
  });
  assert.deepEqual(skipped, ['| OEBPS/rights.xhtml | © Автор, 2026. ISBN 978-0-306-40615-7. Все права защищены. | признаки: выходные данные |']);
});

test('--all: служебная страница стала частью, ссылка в неё — не сноска; файл примечаний — в «Пропущено»', async () => {
  const { index, parts, skipped } = await importBook([
    { href: 'rights.xhtml', body: '<p id="c1">© Автор, 2026. ISBN 978-0-306-40615-7. Все права защищены.</p>' },
    { href: 'c1.xhtml', body: '<p>Раз<sup><a href="rights.xhtml#c1">1</a></sup>, два<sup><a href="notes.xhtml#n1">2</a></sup>.</p>' },
    { href: 'notes.xhtml', body: '<h1>Примечания</h1><p id="n1">Сноска.</p>' },
  ], { all: true });
  assert.deepEqual(parts, {
    '001': '© Автор, 2026. ISBN 978-0-306-40615-7. Все права защищены.\n',
    '002': 'Раз1, два[^1].\n\n[^1]: Сноска.\n',
  });
  assert.match(index, /^- Глав: 2$/m);
  assert.deepEqual(skipped, [`| OEBPS/notes.xhtml | Примечания | ${NOTES} |`]);
});

test('принятая ошибка: примечания Calibre прямо в конце последней главы — «Примечания» остаётся подзаголовком', async () => {
  const { parts, skipped } = await importBook([
    { href: 'c1.xhtml', body: '<h1>Первая</h1><p>Слово<sup><a href="c2.xhtml#n1">1</a></sup>.</p>' },
    { href: 'c2.xhtml', body: '<h1>Вторая</h1><p>Текст.</p><h2>Примечания</h2><p id="n1">1. Сноска.</p>' },
  ]);
  assert.deepEqual(parts, {
    '001': '# Первая\n\nСлово[^1].\n\n[^1]: Сноска.\n',
    '002': '# Вторая\n\nТекст.\n\n## Примечания\n',
  });
  assert.deepEqual(skipped, []);
});

test('принятая ошибка: примечание с заголовком внутри (вид из FB2) — не сноска', async () => {
  const { parts, skipped } = await importBook([
    { href: 'c1.xhtml', body: '<h1>Глава</h1><p>Слово<sup><a href="notes.xhtml#n_1">1</a></sup>.</p>' },
    { href: 'notes.xhtml', body: '<div id="n_1"><h3>1</h3><p>Сноска.</p></div>' },
  ]);
  assert.deepEqual(parts, {
    '001': '# Глава\n\nСлово1.\n',
    '002': '# 1\n\nСноска.\n',
  });
  assert.deepEqual(skipped, []);
});

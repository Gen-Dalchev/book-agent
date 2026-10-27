import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importEpubData } from '../src/import-epub.js';
import { chaptersByHeadings } from '../src/chapters.js';
import { buildEpub, xhtml } from './helpers/epub-builder.js';

// Книга одним файлом (Б-13): весь текст — один файл, первый заголовок — название книги,
// главы — по заголовкам внутри. Тексты — свои.

const IMPORT = fileURLToPath(new URL('../bin/import.js', import.meta.url));
const TITLE = 'Книга одним файлом';
// Абзац длиннее 20 слов: без него файл с названием книги принят за титул.
const LONG = 'Это длинный абзац вступления, в котором больше двадцати слов, чтобы файл с названием книги не приняли за титул издания и не пропустили его при импорте.';
const COVER = { href: 'cover.xhtml', body: '<div><img src="cover.png" alt=""/></div>' };

// Устройство как у книги проверки: название, абзац, «Вступление», три части с главами, «Заключение».
const EXAMPLE = `
  <h1>${TITLE}</h1>
  <p>${LONG}</p>
  <h2>Вступление</h2><p>Текст вступления.</p>
  <h2>Часть первая</h2><p>О первой части.</p>
  <h3>Глава 1</h3><p>Первая глава.</p>
  <h3>Глава 2</h3><p>Вторая глава.</p>
  <h2>Часть вторая</h2>
  <h3>Глава 3</h3><p>Третья.</p>
  <h3>Глава 4</h3><p>Четвёртая.</p>
  <h2>Часть третья</h2><p>О третьей.</p>
  <h3>Глава 5</h3><p>Пятая.</p><h4>Мелочь</h4><p>Мелкое.</p>
  <h3>Глава 6</h3><p>Шестая.</p>
  <h2>Заключение</h2><p>Конец.</p>`;

let tmp;
let count = 0;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'book-agent-one-file-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/**
 * @param {{href: string, body: string, cover?: true}[]} docs в порядке чтения; cover — body epub:type="cover"
 * @returns {Promise<{dir: string, index: string, parts: Record<string, string>}>}
 */
async function importBook(docs, { title = TITLE, all = false } = {}) {
  const items = docs.map((doc, i) => {
    const content = xhtml(doc.body);
    return { id: `d${i}`, href: doc.href, content: doc.cover ? content.replace('<body>', '<body epub:type="cover">') : content };
  });
  const data = await buildEpub({ title, author: 'Автор', language: 'ru', items, spine: items.map((item) => item.id) });
  const dir = path.join(tmp, `book-${count++}`);
  await importEpubData(data, dir, { all });
  const index = await readFile(path.join(dir, 'book.md'), 'utf8');
  const parts = {};
  for (const name of (await readdir(path.join(dir, 'parts'))).sort()) {
    parts[name.replace(/\.md$/, '')] = await readFile(path.join(dir, 'parts', name), 'utf8');
  }
  return { dir, index, parts };
}

test('книга одним файлом: главы по заголовкам, части глав — по подзаголовкам, названия книги в частях нет', async () => {
  const { index, parts } = await importBook([COVER, { href: 'Book.html', body: EXAMPLE }]);
  assert.deepEqual(parts, {
    '001': `${LONG}\n`,
    '002': '# Вступление\n\nТекст вступления.\n',
    '003-00': '# Часть первая\n\nО первой части.\n',
    '003-01': '## Глава 1\n\nПервая глава.\n',
    '003-02': '## Глава 2\n\nВторая глава.\n',
    '004-01': '# Часть вторая\n\n## Глава 3\n\nТретья.\n',
    '004-02': '## Глава 4\n\nЧетвёртая.\n',
    '005-00': '# Часть третья\n\nО третьей.\n',
    '005-01': '## Глава 5\n\nПятая.\n\n### Мелочь\n\nМелкое.\n',
    '005-02': '## Глава 6\n\nШестая.\n',
    '006': '# Заключение\n\nКонец.\n',
  });
  for (const [name, text] of Object.entries(parts)) assert.doesNotMatch(text, new RegExp(TITLE), name);
  assert.match(index, new RegExp(`^# ${TITLE}\n`));
  assert.match(index, /^- Глав: 6\n- Частей: 11$/m);
  assert.match(index, /^\| 001 \| Это длинный абзац вступления, в котором больше двадцати… \| parts\/001\.md \| \d+ \|$/m);
  assert.match(index, /^\| 003 \| Часть первая \| — \| \d+ \|$/m);
  assert.match(index, /^\| 004-01 \| Глава 3 \| parts\/004-01\.md \| \d+ \|$/m);
});

test('главы h2 без подзаголовков — каждая одной частью; название совпадает без учёта регистра и знаков', async () => {
  const { index, parts } = await importBook([{ href: 'Book.html', body: `
    <h1>КНИГА ОДНИМ ФАЙЛОМ!</h1>
    <h2>Глава 1</h2><p>${LONG}</p>
    <h2>Глава 2</h2><p>Вторая.</p>
    <h2>Глава 3</h2><p>Третья.</p>` }], { title: 'Книга одним файлом. Роман' });
  assert.deepEqual(parts, {
    '001': `# Глава 1\n\n${LONG}\n`,
    '002': '# Глава 2\n\nВторая.\n',
    '003': '# Глава 3\n\nТретья.\n',
  });
  assert.match(index, /^- Глав: 3\n- Частей: 3$/m);
});

test('h1 «Примечания» в конце — своя глава, заголовки примечаний — её подглавы', async () => {
  const { parts } = await importBook([{ href: 'Book.html', body: `
    <h1>${TITLE}</h1>
    <h2>Глава 1</h2><p>${LONG}</p>
    <h2>Глава 2</h2><p>Вторая.</p>
    <h1>Примечания</h1><p>Пояснения к тексту.</p>
    <h3>1</h3><p>Первое примечание.</p>
    <h3>2</h3><p>Второе примечание.</p>` }]);
  assert.deepEqual(Object.keys(parts), ['001', '002', '003-00', '003-01', '003-02']);
  assert.equal(parts['003-00'], '# Примечания\n\nПояснения к тексту.\n');
  assert.equal(parts['003-01'], '## 1\n\nПервое примечание.\n');
});

test('заголовок без текста перед главой частью не стал; текст до первой главы с h3 — глава с этим названием', async () => {
  const { index, parts } = await importBook([{ href: 'Book.html', body: `
    <h1>${TITLE}</h1>
    <h3>Эпиграф</h3><p>Слова эпиграфа.</p>
    <h2>Часть первая</h2>
    <h2>Глава 1</h2><p>${LONG}</p>
    <h2>Глава 2</h2><p>Вторая.</p>` }]);
  assert.deepEqual(parts, {
    '001': '# Эпиграф\n\nСлова эпиграфа.\n',
    '002': `# Глава 1\n\n${LONG}\n`,
    '003': '# Глава 2\n\nВторая.\n',
  });
  assert.match(index, /^\| 001 \| Эпиграф \| parts\/001\.md \| \d+ \|$/m);
  assert.doesNotMatch(index, /Часть первая/);
});

test('первый заголовок не название, в названии сноска, нет повторяющегося уровня — как до правила', async () => {
  const other = await importBook([{ href: 'Book.html', body: `
    <h1>Другое название</h1><p>${LONG}</p>
    <h2>Глава 1</h2><p>Первая.</p>
    <h2>Глава 2</h2><p>Вторая.</p>` }]);
  assert.deepEqual(other.parts, {
    '001-00': `# Другое название\n\n${LONG}\n`,
    '001-01': '## Глава 1\n\nПервая.\n',
    '001-02': '## Глава 2\n\nВторая.\n',
  });
  assert.match(other.index, /^- Глав: 1\n- Частей: 3$/m);

  const marked = await importBook([{ href: 'Book.html', body: `
    <h1>${TITLE}<sup><a href="#n1">1</a></sup></h1><p>${LONG}</p>
    <h2>Глава 1</h2><p>Первая.</p>
    <h2>Глава 2</h2><p>Вторая.</p>
    <p id="n1">1 Примечание к названию.</p>` }]);
  assert.deepEqual(marked.parts, {
    '001-00': `# ${TITLE}[^1]\n\n${LONG}\n\n[^1]: Примечание к названию.\n`,
    '001-01': '## Глава 1\n\nПервая.\n',
    '001-02': '## Глава 2\n\nВторая.\n',
  });

  const flat = await importBook([{ href: 'Book.html', body: `
    <h1>${TITLE}</h1><p>${LONG}</p>
    <h2>Глава 1</h2><p>Первая.</p>` }]);
  assert.deepEqual(flat.parts, { '001': `# ${TITLE}\n\n${LONG}\n\n## Глава 1\n\nПервая.\n` });
});

test('название из метаданных пустое — правило не действует', () => {
  const blocks = [
    { type: 'heading', level: 1, text: TITLE },
    { type: 'heading', level: 2, text: 'Глава 1' }, { type: 'text', text: 'Первая.' },
    { type: 'heading', level: 2, text: 'Глава 2' }, { type: 'text', text: 'Вторая.' },
  ];
  assert.equal(chaptersByHeadings({ blocks }, ''), null);
  assert.equal(chaptersByHeadings({ blocks }, TITLE).length, 2);
});

test('сноски внутри файла: определение — в части с меткой, номера свои в каждой части', async () => {
  const { index, parts } = await importBook([{ href: 'Book.html', body: `
    <h1>${TITLE}</h1><p>${LONG}</p>
    <h2>Глава 1</h2><p>Слово<sup><a href="#n1">1</a></sup>.</p>
    <h3>Раздел а</h3><p>Ещё<sup><a href="#n2">2</a></sup>.</p>
    <h3>Раздел б</h3><p>Просто.</p>
    <h2>Глава 2</h2><p>Другое<sup><a href="#n3">3</a></sup>.</p>
    <div class="notes"><p id="n1">1 Первая.</p><p id="n2">2 Вторая.</p><p id="n3">3 Третья.</p></div>` }]);
  assert.deepEqual(parts, {
    '001': `${LONG}\n`,
    '002-00': '# Глава 1\n\nСлово[^1].\n\n[^1]: Первая.\n',
    '002-01': '## Раздел а\n\nЕщё[^1].\n\n[^1]: Вторая.\n',
    '002-02': '## Раздел б\n\nПросто.\n',
    '003': '# Глава 2\n\nДругое[^1].\n\n[^1]: Третья.\n',
  });
  assert.match(index, /^- Сносок: 3$/m);
});

test('две служебные страницы и один файл с текстом — правило действует; с --all файлов больше — как раньше', async () => {
  const docs = [
    { href: 'cover.xhtml', body: '<p>Рисунок на обложке</p>', cover: true },
    { href: 'title.xhtml', body: `<h1>${TITLE}</h1><p>Автор</p>` },
    { href: 'Book.html', body: EXAMPLE },
  ];
  const kept = await importBook(docs);
  assert.match(kept.index, /^- Глав: 6\n- Частей: 11$/m);
  assert.equal(kept.parts['002'], '# Вступление\n\nТекст вступления.\n');
  assert.equal(kept.index.split('\n').filter((line) => line.startsWith('| OEBPS/')).length, 2);

  const all = await importBook(docs, { all: true });
  assert.match(all.index, /^- Глав: 3$/m);
  assert.equal(all.parts['003-00'], `# ${TITLE}\n\n${LONG}\n`);
});

test('--append после книги одним файлом — следующий номер главы', async () => {
  const { dir } = await importBook([COVER, { href: 'Book.html', body: EXAMPLE }]);
  const piece = path.join(tmp, 'piece.txt');
  await writeFile(piece, '# Новая глава\n\nАбзац новой главы.\n');
  const result = spawnSync(process.execPath, [IMPORT, '--append', piece, dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /часть 007/);
  assert.equal(await readFile(path.join(dir, 'parts', '007.md'), 'utf8'), '# Новая глава\n\nАбзац новой главы.\n');
  assert.match(await readFile(path.join(dir, 'book.md'), 'utf8'), /^- Глав: 7$/m);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importEpub } from '../src/import-epub.js';
import { buildEpub, xhtml } from './helpers/epub-builder.js';

// Служебные страницы издания (обложка, титул, выходные данные, оглавление книги)
// не становятся главами и видны в «Пропущено» в book.md. Тексты — свои.

const CLI = fileURLToPath(new URL('../bin/import.js', import.meta.url));

const page = (id, href, body) => ({ id, href, content: xhtml(body) });
const typedBody = (id, href, body, type) =>
  ({ id, href, content: xhtml(body).replace('<body>', `<body epub:type="${type}">`) });
const CHAPTER_ONE = page('ch1', 'ch1.xhtml',
  '<h1>Глава первая</h1><p>Ёжик вышел из дома рано утром<a href="notes.xhtml#n1">1</a>.</p>');
const CHAPTER_TWO = page('ch2', 'ch2.xhtml', '<h1>Глава вторая</h1><p>К вечеру он нашёл дорогу.</p>');

let tmp;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'book-agent-front-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeBook(name, book) {
  const input = path.join(tmp, `${name}.epub`);
  await writeFile(input, await buildEpub({ title: 'Тестовая книга', author: 'Автор Тестов', language: 'ru', ...book }));
  return input;
}

async function importBook(name, book) {
  const out = path.join(tmp, name);
  await importEpub(await writeBook(name, book), out);
  return readBook(out);
}

async function readBook(out) {
  const index = await readFile(path.join(out, 'book.md'), 'utf8');
  const parts = (await readdir(path.join(out, 'parts'))).sort();
  return { index, parts, skipped: skippedRows(index), titles: titleRows(index) };
}

function skippedRows(index) {
  const start = index.indexOf('## Пропущено');
  if (start === -1) return null;
  return index.slice(start).split('\n').filter((line) => line.startsWith('| ')).slice(2);
}

function titleRows(index) {
  const toc = index.slice(index.indexOf('## Оглавление')).split('## Пропущено')[0];
  return toc.split('\n').filter((line) => /^\| \d/.test(line)).map((line) => line.split(' | ').slice(0, 2).join(' | '));
}

function runCli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('EPUB 3: разметка у body, у единственного section и в landmarks', async () => {
  const nav = xhtml(`
    <nav epub:type="toc"><ol><li><a href="ch1.xhtml">Глава первая</a></li></ol></nav>
    <nav epub:type="landmarks"><ol>
      <li><a epub:type="copyright-page" href="rights.xhtml">Права</a></li>
      <li><a epub:type="titlepage" href="whole.xhtml#title">Титул</a></li>
      <li><a epub:type="bodymatter" href="ch1.xhtml">Начало</a></li>
    </ol></nav>`);
  const { skipped, titles, parts } = await importBook('epub3', {
    items: [
      { id: 'nav', href: 'nav.xhtml', content: nav, properties: 'nav' },
      typedBody('cover', 'cover.xhtml', '<p>Рисунок на обложке</p>', 'cover'),
      page('title', 'title.xhtml', '<section epub:type="titlepage"><p>Первая строка титула</p></section>'),
      page('rights', 'rights.xhtml', '<p>Права на это издание у издателя.</p>'),
      typedBody('contents', 'contents.xhtml', '<p>Здесь было бы оглавление издания.</p>', 'frontmatter toc'),
      page('colophon', 'colophon.xhtml', '<section epub:type="colophon"><p>Набрано своими руками</p></section>'),
      // Книга из FB2 — один файл: и титул, и текст. Ни landmarks с фрагментом, ни section не повод пропускать.
      page('whole', 'whole.xhtml', `
        <section epub:type="titlepage" id="title"><p>Книга одним файлом</p></section>
        <section epub:type="chapter"><h2>Сразу текст</h2><p>Ёжик шёл и шёл.</p></section>`),
      CHAPTER_ONE,
    ],
    spine: ['cover', 'title', 'rights', 'contents', 'colophon', 'whole', 'ch1'],
  });
  assert.deepEqual(skipped, [
    '| OEBPS/cover.xhtml | Рисунок на обложке | разметка: cover |',
    '| OEBPS/title.xhtml | Первая строка титула | разметка: titlepage |',
    '| OEBPS/rights.xhtml | Права на это издание у издателя. | разметка: copyright-page |',
    '| OEBPS/contents.xhtml | Здесь было бы оглавление издания. | разметка: toc |',
    '| OEBPS/colophon.xhtml | Набрано своими руками | разметка: colophon |',
  ]);
  assert.deepEqual(titles, ['| 001 | Книга одним файлом', '| 002 | Глава первая']);
  assert.deepEqual(parts, ['001.md', '002.md']);
});

test('EPUB 2: <guide> в OPF, ссылка с фрагментом не в счёт', async () => {
  const { skipped, titles } = await importBook('epub2', {
    version: '2.0',
    items: [
      page('cover', 'cover.html', '<p>Рисунок на обложке</p>'),
      page('title', 'title.html', '<p>Первая строка титула</p>'),
      page('rights', 'rights.html', '<p>Права на это издание у издателя.</p>'),
      page('contents', 'contents.html', '<p>Здесь было бы оглавление издания.</p>'),
      CHAPTER_ONE,
      CHAPTER_TWO,
    ],
    spine: ['cover', 'title', 'rights', 'contents', 'ch1', 'ch2'],
    guide: `
    <reference type="cover" title="Обложка" href="cover.html"/>
    <reference type="title-page" title="Титул" href="title.html"/>
    <reference type="copyright-page" title="Права" href="rights.html"/>
    <reference type="toc" title="Содержание" href="contents.html"/>
    <reference type="text" title="Начало" href="ch1.xhtml"/>
    <reference type="toc" title="Внутри главы" href="ch2.xhtml#contents"/>`,
  });
  assert.deepEqual(skipped, [
    '| OEBPS/cover.html | Рисунок на обложке | разметка: cover |',
    '| OEBPS/title.html | Первая строка титула | разметка: title-page |',
    '| OEBPS/rights.html | Права на это издание у издателя. | разметка: copyright-page |',
    '| OEBPS/contents.html | Здесь было бы оглавление издания. | разметка: toc |',
  ]);
  assert.deepEqual(titles, ['| 001 | Глава первая', '| 002 | Глава вторая']);
});

// Без разметки: служебные страницы — по признакам; остальное остаётся частями.
const PLAIN_BOOK = {
  items: [
    page('img', 'cover.xhtml', '<div><img src="cover.png" alt="Обложка"/></div>'),
    page('title', 'title.xhtml', '<p>Автор Тестов</p><h1>ТЕСТОВАЯ КНИГА!</h1><p>Роман</p>'),
    page('rights', 'rights.xhtml', `
      <p>Выходные данные этого издания и несколько слов о книге для читателя</p>
      <p>УДК 821.161.1 ББК 84(2Рос=Рус)6</p>
      <p>ISBN 978-0-306-40615-7</p>
      <p>© Автор Тестов, 2020. Все права защищены.</p>
      <p>Аннотация: ёжик ищет дорогу домой и находит.</p>`),
    page('contents', 'contents.xhtml', `
      <h1>Содержание</h1>
      <p><a href="part1.xhtml">Часть первая</a></p>
      <div class="toc"><a href="ch1.xhtml">Глава первая</a></div>
      <ul><li><a href="ch2.xhtml#start">Глава вторая</a></li><li><a href="notes.xhtml">Примечания</a></li></ul>`),
    page('dedication', 'dedication.xhtml', '<p>Посвящается маме</p>'),
    page('part1', 'part1.xhtml', '<h1>Часть первая</h1>'),
    page('epigraph', 'epigraph.xhtml',
      '<blockquote><p>Кто ищет дорогу, тот её найдёт.</p><p>— Старая поговорка</p></blockquote>'),
    CHAPTER_ONE,
    CHAPTER_TWO,
    page('notes', 'notes.xhtml', `
      <h1>Примечания</h1>
      <p id="n1"><a href="ch1.xhtml#r1">1</a> Ёжик — колючий зверёк.</p>
      <p id="n2"><a href="ch2.xhtml#r2">2</a> Дорога — та, что к дому.</p>`),
    page('appendix', 'appendix.xhtml', '<h1>Приложение</h1><p>© Автор Тестов</p><p>ISBN 978-0-306-40615-7</p>'),
  ],
  spine: ['img', 'title', 'rights', 'contents', 'dedication', 'part1', 'epigraph', 'ch1', 'ch2', 'notes',
    { id: 'appendix', linear: 'no' }],
};

test('без разметки: титул, выходные данные и оглавление — по признакам', async () => {
  const { index, skipped, titles, parts } = await importBook('plain', PLAIN_BOOK);
  assert.deepEqual(skipped, [
    '| OEBPS/title.xhtml | Автор Тестов | признаки: титул |',
    '| OEBPS/rights.xhtml | Выходные данные этого издания и несколько слов о… | признаки: выходные данные |',
    '| OEBPS/contents.xhtml | Содержание | признаки: оглавление |',
  ]);
  assert.deepEqual(titles, [
    '| 001 | Посвящается маме',
    '| 002 | Часть первая',
    '| 003 | Кто ищет дорогу, тот её найдёт. — Старая…',
    '| 004 | Глава первая',
    '| 005 | Глава вторая',
    '| 006 | Примечания',
    '| 007 | Приложение',
  ]);
  assert.equal(parts.length, 7);
  assert.match(index, /^- Глав: 7$/m);
  assert.ok(index.indexOf('## Оглавление') < index.indexOf('## Пропущено'));
  assert.match(index, /\n## Пропущено\n\n\| Файл \| Начало \| Причина \|\n\| --- \| --- \| --- \|\n/);
});

test('--all в любом месте — пропусков нет, пустые страницы по-прежнему не части', async () => {
  const input = await writeBook('plain-all', PLAIN_BOOK);
  for (const [name, args] of [['all-end', (out) => [input, out, '--all']], ['all-start', (out) => ['--all', input, out]]]) {
    const out = path.join(tmp, name);
    const result = runCli(...args(out));
    assert.equal(result.status, 0, result.stderr);
    const { index, skipped, titles } = await readBook(out);
    assert.equal(skipped, null);
    assert.doesNotMatch(index, /Пропущено/);
    assert.deepEqual(titles.slice(0, 4), [
      '| 001 | Автор Тестов',
      '| 002 | Выходные данные этого издания и несколько слов о…',
      '| 003 | Содержание',
      '| 004 | Посвящается маме',
    ]);
    assert.equal(titles.length, 10);
  }
});

test('ничего не пропущено — раздела «Пропущено» нет', async () => {
  const { index } = await importBook('nothing', { items: [CHAPTER_ONE, CHAPTER_TWO], spine: ['ch1', 'ch2'] });
  assert.doesNotMatch(index, /Пропущено/);
});

test('все страницы служебные — ошибка с подсказкой про --all, папка не создаётся', async () => {
  const input = await writeBook('only-front', {
    items: PLAIN_BOOK.items.filter((item) => ['img', 'title', 'rights'].includes(item.id)),
    spine: ['img', 'title', 'rights'],
  });
  const out = path.join(tmp, 'only-front');
  const result = runCli(input, out);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Ошибка: В книге не нашлось текста: все страницы — служебные \(обложка, титул, выходные данные, оглавление\)\. Чтобы взять всё, добавьте --all\./);
  assert.equal(existsSync(out), false);
});

test('подсказка команды называет ключ --all', () => {
  const result = runCli('одна.epub');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Как запускать: npm run import -- <файл\.epub> <папка> \[--all\]/);
});

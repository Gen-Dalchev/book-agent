import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEpub, xhtml } from './helpers/epub-builder.js';
import { buildPdf } from './helpers/pdf-builder.js';
import { BOOK_PDF, EDGES_PDF } from './fixtures/make-book-pdf.js';

const CLI = fileURLToPath(new URL('../bin/import.js', import.meta.url));

let tmp;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'book-agent-pdf-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function runImport(input, output, ...flags) {
  return spawnSync(process.execPath, [CLI, input, output, ...flags], { encoding: 'utf8' });
}

const read = (dir, file) => readFile(path.join(dir, file), 'utf8');

// Латиница стандартным шрифтом — для крайних случаев кириллица не нужна.
const LATIN_PAGE = [
  { text: 'Plain heading', size: 16 },
  { text: 'First paragraph starts', indent: true, gap: 8 },
  { text: 'and ends here.' },
  { text: 'Second paragraph.', indent: true },
];

async function pdfFile(name, book) {
  const file = path.join(tmp, name);
  await writeFile(file, await buildPdf(book));
  return file;
}

test('книга из PDF: главы и подглавы по закладкам, абзацы, текст посимвольно', async () => {
  const out = path.join(tmp, 'book');
  const result = runImport(BOOK_PDF, out);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Готово: «Тестовая книга» — глав: 3, частей: 6\./);

  assert.deepEqual(await readdir(path.join(out, 'parts')),
    ['001.md', '002-00.md', '002-01.md', '003-00.md', '003-01.md', '003-02.md']);
  const index = await read(out, 'book.md');
  assert.match(index, /^# Тестовая книга\n\n- Автор: Йозеф Ёлкин\n/);
  for (const field of ['Переводчик', 'Издатель', 'Год', 'ISBN']) {
    assert.match(index, new RegExp(`^- ${field}: не указан$`, 'mu'));
  }
  assert.doesNotMatch(index, /Пропущено/);
  assert.match(index, /^\| 002 \| Глава первая \| — \| \d+ \|$/mu);
  assert.match(index, /^\| 002-01 \| Утро \| parts\/002-01\.md \| \d+ \|$/mu);
  assert.match(index, /^\| 003 \| CHAPTER two \| — \| \d+ \|$/mu);

  assert.equal(await read(out, 'parts/001.md'), '# До первой закладки\n\nТестовая книга\n');
  assert.equal(await read(out, 'parts/002-00.md'),
    '# Глава первая\n\nВступление к главе: ёж, йод и немного English text.\n');
  assert.equal(await read(out, 'parts/002-01.md'), [
    '## Утро',
    'Ёжик шёл домой по тропинке, и йод звенел в кармане.',
    'Второй абзац начинается здесь и переходит на следующую страницу без отступа.',
    'Third paragraph, in English, ends with «ёлка».',
  ].join('\n\n') + '\n');
  // Именованное назначение; напечатанный «Chapter Two» совпадает с «CHAPTER  two» без учёта регистра и пробелов.
  assert.equal(await read(out, 'parts/003-00.md'), '# CHAPTER two\n\nBefore the first section, two lines long.\n');
  assert.equal(await read(out, 'parts/003-01.md'), '## Вечер\n\nКороткий абзац вечера, тоже в две строки.\n');
  // Закладка третьего уровня («Глубже») текст не делит и заголовка не даёт.
  assert.equal(await read(out, 'parts/003-02.md'), '## Ночь\n\nПоследний абзац всей книги кончается тут.\n');
});

test('колонтитулы и номера страниц убраны, год остался, переносы склеены', async () => {
  const out = path.join(tmp, 'edges');
  const result = runImport(EDGES_PDF, out);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(path.join(out, 'parts')), ['001.md', '002.md']);
  assert.equal(await read(out, 'parts/001.md'), [
    '# Первая часть',
    'Колонтитулы стоят у краёв страницы, а текст между ними идёт своим чередом, и переносы в нём склеиваются.',
    'Если кто-нибудь спросит, зачем это нужно, ответ простой: чтобы читать без помех. Слово на границе страниц тоже склеится.',
    'Год внизу этой страницы — не номер страницы, он остаётся.',
    '1924',
    'Мягкий перенос внутри строки исчезает, слово остаётся целым.',
  ].join('\n\n') + '\n');
  // «well-» + «known» → «wellknown» — принятая ошибка: составное слово на своём дефисе склеивается.
  assert.equal(await read(out, 'parts/002.md'), [
    '# Вторая часть',
    'Здесь у верхнего края нет колонтитула, а внизу он есть.',
    'The last page is in English: a wellknown word and a hyphenated one are both joined.',
  ].join('\n\n') + '\n');
});

test('ключ --all на PDF ничего не меняет', async () => {
  const plain = path.join(tmp, 'plain');
  const all = path.join(tmp, 'all');
  assert.equal(runImport(BOOK_PDF, plain).status, 0);
  assert.equal(runImport(BOOK_PDF, all, '--all').status, 0);
  const files = await readdir(path.join(plain, 'parts'));
  assert.deepEqual(await readdir(path.join(all, 'parts')), files);
  for (const file of ['book.md', ...files.map((name) => `parts/${name}`)]) {
    assert.equal(await read(all, file), await read(plain, file), file);
  }
});

test('PDF без закладок — одна глава «Текст» и предупреждение, код 0', async () => {
  const input = await pdfFile('no-bookmarks.pdf', { title: 'Plain', pages: [LATIN_PAGE] });
  const out = path.join(tmp, 'no-bookmarks');
  const result = runImport(input, out);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /в PDF нет закладок — главы не размечены/);
  assert.deepEqual(await readdir(path.join(out, 'parts')), ['001.md']);
  assert.equal(await read(out, 'parts/001.md'),
    '# Текст\n\nPlain heading\n\nFirst paragraph starts and ends here.\n\nSecond paragraph.\n');
  const index = await read(out, 'book.md');
  assert.match(index, /^# Plain\n\n- Автор: не указан\n/);
});

test('страница без текста посреди книги ничего не ломает', async () => {
  const input = await pdfFile('blank-page.pdf', {
    pages: [LATIN_PAGE, [], [{ text: 'After the blank page.', indent: true }]],
    bookmarks: [{ title: 'One', page: 0 }, { title: 'Two', page: 1 }],
  });
  const out = path.join(tmp, 'blank-page');
  const result = runImport(input, out);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await read(out, 'parts/002.md'), '# Two\n\nAfter the blank page.\n');
});

test('ни на одной странице нет текста (скан) — ошибка, папка не создаётся', async () => {
  const input = await pdfFile('scan.pdf', { pages: [[], []], bookmarks: [{ title: 'One', page: 0 }] });
  const out = path.join(tmp, 'scan');
  const result = runImport(input, out);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /В PDF нет текстового слоя — похоже на скан; такие пока не поддерживаются/);
  assert.equal(existsSync(out), false);
});

test('битый PDF — понятная ошибка, папка не создаётся', async () => {
  const good = await buildPdf({ pages: [LATIN_PAGE] });
  for (const [name, content] of [
    ['garbage.pdf', '%PDF-1.7\nэто не PDF, а обрывок\n'],
    ['cut.pdf', good.slice(0, 200)],
  ]) {
    const input = path.join(tmp, name);
    await writeFile(input, content);
    const out = path.join(tmp, `broken-${name}`);
    const result = runImport(input, out);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, /Ошибка: (Файл не читается как PDF|PDF повреждён)/, name);
    assert.doesNotMatch(result.stderr, /at .*\.js/, name);
    assert.equal(existsSync(out), false, name);
  }
});

test('файл .pdf, который не PDF и не EPUB, — ошибка, папка не создаётся', async () => {
  const input = path.join(tmp, 'fake.pdf');
  await writeFile(input, 'это просто текст');
  const out = path.join(tmp, 'fake');
  const result = runImport(input, out);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Ошибка: Файл не похож на PDF или EPUB/);
  assert.equal(existsSync(out), false);
});

test('EPUB с расширением .pdf импортируется как EPUB', async () => {
  const input = path.join(tmp, 'really-epub.pdf');
  await writeFile(input, await buildEpub({
    title: 'Книга', author: 'А', language: 'ru',
    items: [{ id: 'c', href: 'c.xhtml', content: xhtml('<h1>Глава</h1><p>Текст.</p>') }],
    spine: ['c'],
  }));
  const out = path.join(tmp, 'really-epub');
  const result = runImport(input, out);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(path.join(out, 'parts')), ['001.md']);
});

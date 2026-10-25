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

// Главы по крупному шрифту. Основной текст — 12 (по умолчанию), его в книге больше всего;
// заголовок — не мельче 1,1 × 12 = 13,2.
const para = (text, size) => ({ text, indent: true, size });
const big = (text, size) => ({ text, size });
const BODY = para('Body text, long enough to be the main size.');

async function importHeadings(name, pages, bookmarks) {
  const input = await pdfFile(`${name}.pdf`, { title: 'Sized', pages, bookmarks });
  const out = path.join(tmp, name);
  const result = runImport(input, out);
  assert.equal(result.status, 0, result.stderr);
  return { out, result, files: await readdir(path.join(out, 'parts')) };
}

test('PDF без закладок: главы и подглавы по крупному шрифту, предупреждение, оглавление', async () => {
  const { out, result, files } = await importHeadings('font-headings', [
    [big('Chapter One', 18), para('Intro text of the first chapter.'),
      big('First Section', 15), para('Body of the first section, a few words.')],
    [big('Second Section', 15), para('Body of the second section, a few words.')],
    [big('Chapter Two', 18), para('The second chapter has no sections at all.')],
  ]);
  assert.match(result.stderr,
    /в PDF нет закладок — главы размечены по крупному шрифту, проверьте оглавление в book\.md/);
  assert.doesNotMatch(result.stderr, /главы не размечены/);
  assert.match(result.stdout, /глав: 2, частей: 4\./);
  assert.deepEqual(files, ['001-00.md', '001-01.md', '001-02.md', '002.md']);
  assert.equal(await read(out, 'parts/001-00.md'), '# Chapter One\n\nIntro text of the first chapter.\n');
  assert.equal(await read(out, 'parts/001-01.md'), '## First Section\n\nBody of the first section, a few words.\n');
  assert.equal(await read(out, 'parts/001-02.md'), '## Second Section\n\nBody of the second section, a few words.\n');
  assert.equal(await read(out, 'parts/002.md'), '# Chapter Two\n\nThe second chapter has no sections at all.\n');
  const index = await read(out, 'book.md');
  assert.match(index, /^\| 001 \| Chapter One \| — \| \d+ \|$/mu);
  assert.match(index, /^\| 001-01 \| First Section \| parts\/001-01\.md \| \d+ \|$/mu);
  assert.match(index, /^\| 001-02 \| Second Section \| parts\/001-02\.md \| \d+ \|$/mu);
  assert.match(index, /^\| 002 \| Chapter Two \| parts\/002\.md \| \d+ \|$/mu);
});

test('Word: заголовки 14 при тексте 12 — главы, 13 — текст', async () => {
  const { out, result, files } = await importHeadings('word-headings', [
    [big('Chapter One', 14), BODY, big('Minor One', 13), BODY],
    [big('Chapter Two', 14), BODY, big('Minor Two', 13), BODY],
    [big('Chapter Three', 14), BODY],
  ]);
  assert.match(result.stderr, /главы размечены по крупному шрифту, проверьте оглавление в book\.md/);
  assert.deepEqual(files, ['001.md', '002.md', '003.md']);
  assert.match(await read(out, 'parts/001.md'), /^# Chapter One\n\nBody text[^#]*Minor One[^#]*$/);
  assert.match(await read(out, 'parts/002.md'), /^# Chapter Two\n\nBody text[^#]*Minor Two[^#]*$/);
  assert.match(await read(out, 'parts/003.md'), /^# Chapter Three\n\nBody text[^#]*$/);
});

test('заголовок ровно 1,1 × основного (13,2 при 12, 11 при 10) — заголовок', async () => {
  const exact = await importHeadings('exact-threshold', [
    [big('Chapter Alpha', 13.2), BODY],
    [big('Chapter Beta', 13.2), BODY],
  ]);
  assert.deepEqual(exact.files, ['001.md', '002.md']);
  assert.match(await read(exact.out, 'parts/001.md'), /^# Chapter Alpha\n\nBody text[^#]*$/);
  assert.match(await read(exact.out, 'parts/002.md'), /^# Chapter Beta\n\nBody text[^#]*$/);

  // Основной 10, примечания 9, заголовки 11.
  const body = para('Body text, long enough to be the main size of this book.', 10);
  const small = await importHeadings('small-body', [
    [big('Chapter Alpha', 11), body, body, para('A note.', 9)],
    [big('Chapter Beta', 11), body, body, para('Another note.', 9)],
  ]);
  assert.deepEqual(small.files, ['001.md', '002.md']);
  assert.match(await read(small.out, 'parts/001.md'), /^# Chapter Alpha\n\nBody text[^#]*A note\.\n$/);
  assert.match(await read(small.out, 'parts/002.md'), /^# Chapter Beta\n\nBody text[^#]*Another note\.\n$/);
});

test('название и автор 16 подряд на первой странице, главы 14 — одна строка ### до глав', async () => {
  const { out, files } = await importHeadings('title-and-chapters', [
    [big('Great Book', 16), big('Some Author', 16)],
    [big('Chapter Alpha', 14), BODY],
    [big('Chapter Beta', 14), BODY],
  ]);
  assert.deepEqual(files, ['001.md', '002.md', '003.md']);
  assert.equal(await read(out, 'parts/001.md'), '# До первого заголовка\n\n### Great Book Some Author\n');
  assert.match(await read(out, 'parts/002.md'), /^# Chapter Alpha\n\nBody text[^#]*$/);
  assert.match(await read(out, 'parts/003.md'), /^# Chapter Beta\n\nBody text[^#]*$/);
});

test('строки 13,3 при основном 12 на двух страницах и главы 14 — подглавы', async () => {
  const { out, files } = await importHeadings('slightly-bigger', [
    [big('Chapter One', 14), para('Intro text of the first chapter.'), big('Epigraph One', 13.3), BODY],
    [big('Epigraph Two', 13.3), BODY],
    [big('Chapter Two', 14), BODY],
  ]);
  assert.deepEqual(files, ['001-00.md', '001-01.md', '001-02.md', '002.md']);
  assert.equal(await read(out, 'parts/001-00.md'), '# Chapter One\n\nIntro text of the first chapter.\n');
  assert.match(await read(out, 'parts/001-01.md'), /^## Epigraph One\n\nBody text[^#]*$/);
  assert.match(await read(out, 'parts/001-02.md'), /^## Epigraph Two\n\nBody text[^#]*$/);
  assert.match(await read(out, 'parts/002.md'), /^# Chapter Two\n\nBody text[^#]*$/);
});

test('заголовок в две строки: после номера — через «. », иначе через пробел', async () => {
  const { out, files } = await importHeadings('two-line-headings', [
    [big('Chapter 1', 18), big('Beginning', 18), BODY],
    [big('A Rather Long Chapter', 18), big('Title in Two Lines', 18), BODY],
  ]);
  assert.deepEqual(files, ['001.md', '002.md']);
  assert.match(await read(out, 'parts/001.md'), /^# Chapter 1\. Beginning\n\nBody text/);
  assert.match(await read(out, 'parts/002.md'), /^# A Rather Long Chapter Title in Two Lines\n\nBody text/);
});

test('номер главы отдельной строкой крупнее названия — одна глава «1. Beginning»', async () => {
  const { out, files } = await importHeadings('number-line', [
    [big('1', 36), big('Beginning', 18), BODY],
    [big('2', 36), big('Middle', 18), BODY],
  ]);
  assert.deepEqual(files, ['001.md', '002.md']);
  assert.match(await read(out, 'parts/001.md'), /^# 1\. Beginning\n\nBody text[^#]*$/);
  assert.match(await read(out, 'parts/002.md'), /^# 2\. Middle\n\nBody text[^#]*$/);
});

test('титул крупным шрифтом — не главы: строки ### в «До первого заголовка»', async () => {
  const chapters = [[big('Chapter Alpha', 18), BODY], [big('Chapter Beta', 18), BODY]];
  const once = await importHeadings('title-once', [
    [big('Some Author', 20), big('Great Book', 24), big('A Subtitle', 20)],
    ...chapters,
  ]);
  assert.deepEqual(once.files, ['001.md', '002.md', '003.md']);
  assert.equal(await read(once.out, 'parts/001.md'),
    '# До первого заголовка\n\n### Some Author\n\n### Great Book\n\n### A Subtitle\n');
  assert.match(await read(once.out, 'parts/002.md'), /^# Chapter Alpha\n\nBody text/);

  // Название дважды одним текстом: второе — текстом, уровня не даёт.
  const twice = await importHeadings('title-twice', [
    [big('Great Book', 24)],
    [big('Great Book', 24), para('Some Author')],
    ...chapters,
  ]);
  assert.deepEqual(twice.files, ['001.md', '002.md', '003.md']);
  assert.equal(await read(twice.out, 'parts/001.md'),
    '# До первого заголовка\n\n### Great Book\n\nGreat Book\n\nSome Author\n');
});

test('буквица — не заголовок: ни отдельной строкой, ни на одной линии с текстом', async () => {
  const { out, files } = await importHeadings('drop-cap', [
    [big('Chapter Alpha', 18), { text: 'W', size: 30, indent: true }, { text: 'hen it began, the story was short.' }, BODY],
    [big('Chapter Beta', 18), BODY,
      { text: 'W', size: 30, at: { x: 50, y: 200 } }, { text: 'hen it began again.', at: { x: 80, y: 200 } }],
  ]);
  assert.deepEqual(files, ['001.md', '002.md']);
  const first = await read(out, 'parts/001.md');
  assert.match(first, /^# Chapter Alpha\n\n[^#]*hen it began, the story was short\.[^#]*$/);
  const second = await read(out, 'parts/002.md');
  assert.match(second, /^# Chapter Beta\n\n[^#]*hen it began again\.\n$/);
});

test('крупный колонтитул с названием главы на каждой странице — одна глава на название', async () => {
  const header = (title) => ({ text: title, size: 18, at: { y: 470 } });
  const { out, files } = await importHeadings('big-running-header', [
    [header('Chapter Alpha'), BODY], [header('Chapter Alpha'), BODY],
    [header('Chapter Beta'), BODY], [header('Chapter Beta'), BODY],
    [header('Chapter Gamma'), BODY], [header('Chapter Gamma'), BODY],
  ]);
  assert.deepEqual(files, ['001.md', '002.md', '003.md']);
  const index = await read(out, 'book.md');
  assert.match(index, /^\| 001 \| Chapter Alpha \|/mu);
  assert.match(index, /^\| 002 \| Chapter Beta \|/mu);
  assert.match(index, /^\| 003 \| Chapter Gamma \|/mu);
});

test('строка оглавления с номером страницы и четыре крупные строки подряд — текст', async () => {
  const { out, files } = await importHeadings('toc-and-big-text', [
    [big('Chapter 1 ........ 5', 18), para('Some words.')],
    [big('Chapter Alpha', 18), BODY,
      big('Big one', 16), big('Big two', 16), big('Big three', 16), big('Big four', 16), BODY],
    [big('Chapter Beta', 18), BODY],
  ]);
  assert.deepEqual(files, ['001.md', '002.md', '003.md']);
  assert.equal(await read(out, 'parts/001.md'), '# До первого заголовка\n\nChapter 1 ........ 5\n\nSome words.\n');
  const alpha = await read(out, 'parts/002.md');
  assert.match(alpha, /^# Chapter Alpha\n\n[^#]*Big one Big two Big three Big four[^#]*$/);
});

test('текст и подглава до первой главы — отдельные главы', async () => {
  const { out, files } = await importHeadings('before-first-chapter', [
    [para('Opening words.'), big('Early Section', 15), BODY],
    [big('Chapter Alpha', 18), BODY, big('Section One', 15), BODY],
    [big('Chapter Beta', 18), big('Section Two', 15), BODY],
  ]);
  assert.deepEqual(files, ['001.md', '002.md', '003-00.md', '003-01.md', '004-01.md']);
  assert.equal(await read(out, 'parts/001.md'), '# До первого заголовка\n\nOpening words.\n');
  assert.match(await read(out, 'parts/002.md'), /^# Early Section\n\nBody text[^#]*$/);
  assert.match(await read(out, 'parts/003-00.md'), /^# Chapter Alpha\n\nBody text[^#]*$/);
  assert.match(await read(out, 'parts/003-01.md'), /^## Section One\n\nBody text[^#]*$/);
  assert.match(await read(out, 'parts/004-01.md'), /^# Chapter Beta\n\n## Section Two\n\nBody text[^#]*$/);
});

test('PDF с закладками и крупными заголовками — части как по закладкам', async () => {
  const { out, result, files } = await importHeadings('bookmarks-and-sizes', [
    [big('Chapter One', 18), BODY, big('First Section', 15), BODY],
    [big('Second Section', 15), BODY],
    [big('Chapter Two', 18), BODY],
  ], [{ title: 'Part X', page: 0 }, { title: 'Part Y', page: 2 }]);
  assert.equal(result.stderr, '');
  assert.deepEqual(files, ['001.md', '002.md']);
  assert.match(await read(out, 'parts/001.md'), /^# Part X\n\nChapter One\n\n[^#]*First Section[^#]*Second Section[^#]*$/);
  assert.match(await read(out, 'parts/002.md'), /^# Part Y\n\nChapter Two\n\nBody text[^#]*$/);

  // Заголовки чуть крупнее основного (14 и 13,3 при 12) при закладках — тоже текст.
  const word = await importHeadings('bookmarks-and-word-sizes', [
    [big('Chapter One', 14), BODY, big('Epigraph One', 13.3), BODY],
    [big('Epigraph Two', 13.3), BODY],
    [big('Chapter Two', 14), BODY],
  ], [{ title: 'Part X', page: 0 }, { title: 'Part Y', page: 2 }]);
  assert.equal(word.result.stderr, '');
  assert.deepEqual(word.files, ['001.md', '002.md']);
  assert.match(await read(word.out, 'parts/001.md'), /^# Part X\n\nChapter One\n\n[^#]*Epigraph One[^#]*Epigraph Two[^#]*$/);
  assert.match(await read(word.out, 'parts/002.md'), /^# Part Y\n\nChapter Two\n\nBody text[^#]*$/);
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

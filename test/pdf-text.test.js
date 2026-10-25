import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textLines, paragraphs } from '../src/pdf-text.js';
import { chaptersFromBookmarks, singleChapter } from '../src/pdf-chapters.js';
import { detectFormat } from '../src/format.js';

// Кусок текста в виде pdfjs: строка по координатам, шрифт 12, межстрочный 14.
const piece = (str, x, y, hasEOL = true) => ({ str, transform: [12, 0, 0, 12, x, y], height: 12, hasEOL });
const LEFT = 72;
const INDENT = 96;
// Страница из строк: [текст, отступ?, лишний промежуток перед строкой?]
function page(rows) {
  let y = 760;
  return rows.map(([text, indent = false, gapBefore = 0]) => {
    y -= 14 + gapBefore;
    return piece(text, indent ? INDENT : LEFT, y);
  });
}

test('куски одной высоты — одна строка, hasEOL обрывает строку', () => {
  const lines = textLines([[
    piece('Ёжик ', LEFT, 700, false), piece('шёл', 100, 700, false), piece('', 0, 0, true),
    piece('домой', LEFT, 700, false),
    { str: ' ', transform: [1, 0, 0, 1, 0, 0], height: 0, hasEOL: false },
    piece('и йод', 120, 700),
  ]]);
  assert.deepEqual(lines.map((line) => line.text), ['Ёжик шёл', 'домой и йод']);
});

test('абзацы — по отступу первой строки и по широкому промежутку', () => {
  const lines = textLines([page([
    ['Первая строка', true], ['первого абзаца.'],
    ['Второй абзац', true], ['на две строки.'],
    ['Третий без отступа,', false, 12], ['но после промежутка.'],
  ])]);
  assert.deepEqual(paragraphs(lines), [
    'Первая строка первого абзаца.',
    'Второй абзац на две строки.',
    'Третий без отступа, но после промежутка.',
  ]);
});

test('абзац через границу страниц — один абзац; отступ на новой странице — новый', () => {
  const lines = textLines([
    page([['Начало абзаца', true], ['идёт дальше']]),
    page([['и кончается здесь.'], ['Новый абзац', true], ['с новой страницы.']]),
  ]);
  assert.deepEqual(paragraphs(lines), [
    'Начало абзаца идёт дальше и кончается здесь.',
    'Новый абзац с новой страницы.',
  ]);
  assert.deepEqual(lines.map((line) => line.page), [0, 0, 1, 1, 1]);
});

test('страница без текста ничего не ломает', () => {
  const lines = textLines([page([['Раз,', true], ['и всё.']]), [], page([['Два,', true], ['и всё.']])]);
  assert.deepEqual(paragraphs(lines), ['Раз, и всё.', 'Два, и всё.']);
});

// Книга: стр. 0 — титул; стр. 1 — глава 1 с одной подглавой; стр. 2 — глава 2 с двумя.
const BOOK = textLines([
  page([['Тестовая книга', true]]),
  page([
    ['Глава первая', true], ['Вступление', true], ['к главе.'],
    ['Утро', true, 12], ['Ёжик шёл домой,', true], ['и йод звенел.'],
  ]),
  page([
    ['Chapter Two', true], ['Morning', true, 12], ['First part', true], ['goes on.'],
    ['Evening', true, 12], ['Second part', true], ['ends.'],
  ]),
]);
const yOf = (text) => BOOK.find((line) => line.text === text).y + 10;

test('главы и подглавы — по закладкам; напечатанный заголовок не повторяется', () => {
  const chapters = chaptersFromBookmarks(BOOK, [
    { title: 'ГЛАВА  первая', page: 1, y: null, children: [
      { title: 'Утро', page: 1, y: yOf('Утро'), children: [] },
    ] },
    { title: 'Chapter Two', page: 2, y: null, children: [
      { title: 'Morning', page: 2, y: yOf('Morning'), children: [
        { title: 'Глубже', page: 2, y: yOf('goes on.'), children: [] },
      ] },
      { title: 'Evening', page: 2, y: yOf('Evening'), children: [] },
    ] },
  ]);
  assert.deepEqual(chapters.map((chapter) => chapter.title), ['До первой закладки', 'ГЛАВА первая', 'Chapter Two']);
  assert.deepEqual(chapters[0].parts.map((part) => part.markdown), ['# До первой закладки\n\nТестовая книга\n']);
  assert.deepEqual(chapters[1].parts.map((part) => [part.kind, part.title, part.markdown]), [
    ['intro', 'ГЛАВА первая', '# ГЛАВА первая\n\nВступление к главе.\n'],
    ['section', 'Утро', '## Утро\n\nЁжик шёл домой, и йод звенел.\n'],
  ]);
  assert.deepEqual(chapters[2].parts.map((part) => [part.kind, part.markdown]), [
    ['section', '# Chapter Two\n\n## Morning\n\nFirst part goes on.\n'],
    ['section', '## Evening\n\nSecond part ends.\n'],
  ]);
});

test('глава без подглав — целиком; без места на странице — с начала страницы', () => {
  const chapters = chaptersFromBookmarks(BOOK.filter((line) => line.page > 0), [
    { title: 'Одна', page: 1, y: null, children: [] },
    { title: 'Две', page: 2, y: null, children: [] },
  ]);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].parts.length, 1);
  assert.equal(chapters[0].parts[0].kind, 'whole');
  assert.equal(chapters[0].parts[0].markdown,
    '# Одна\n\nГлава первая\n\nВступление к главе.\n\nУтро\n\nЁжик шёл домой, и йод звенел.\n');
  assert.match(chapters[1].parts[0].markdown, /^# Две\n\nChapter Two\n\nMorning\n/);
});

test('без закладок — одна глава «Текст»', () => {
  const [chapter, ...rest] = singleChapter(BOOK);
  assert.equal(rest.length, 0);
  assert.equal(chapter.title, 'Текст');
  assert.equal(chapter.parts[0].kind, 'whole');
  assert.match(chapter.parts[0].markdown, /^# Текст\n\nТестовая книга\n\nГлава первая\n/);
});

test('формат — по первым байтам, а не по расширению', () => {
  const bytes = (text) => new TextEncoder().encode(text);
  assert.equal(detectFormat(bytes('%PDF-1.7\n...')), 'pdf');
  assert.equal(detectFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])), 'epub');
  assert.equal(detectFormat(bytes('просто текст')), null);
  assert.equal(detectFormat(new Uint8Array()), null);
});

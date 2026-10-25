// Строки PDF + закладки (или заголовки по крупному шрифту) → главы и части (типы Chapter/Part из chapters.js).
// Главы и подглавы — по закладкам напрямую, без правила «повторяющийся уровень»:
// закладка верхнего уровня — глава, второго — подглава, даже если она одна;
// закладки глубже не делят текст и не дают заголовков.
import { paragraphs } from './pdf-text.js';
import { bookWords } from './pdf-clean.js';
import { CHAPTER, INLINE } from './pdf-headings.js';
import { countWords } from './words.js';

export const NO_BOOKMARKS_TITLE = 'Текст';
// Текст до первой закладки (титул, аннотация) не выбрасывается: он идёт отдельной главой.
export const BEFORE_BOOKMARKS_TITLE = 'До первой закладки';
// То же для глав по крупному шрифту.
export const BEFORE_HEADINGS_TITLE = 'До первого заголовка';
const UNTITLED = 'Без названия';

/**
 * Место закладки: страница (с 0) и, если назначение его даёт, высота на странице.
 * @typedef {{title: string, page: number, y: number | null, children: Bookmark[]}} Bookmark
 */

/**
 * @param {import('./pdf-text.js').Line[]} lines строки всей книги
 * @param {Bookmark[]} bookmarks закладки верхнего уровня, в порядке оглавления PDF
 * @param {Set<string>} [words] словарь книги для склейки строк (bookWords из pdf-clean.js)
 * @returns {import('./chapters.js').Chapter[]}
 */
export function chaptersFromBookmarks(lines, bookmarks, words = bookWords(lines)) {
  const starts = bookmarks.map((bookmark) => lineAt(lines, bookmark));
  const chapters = [];
  if (starts.length > 0 && starts[0] > 0) {
    chapters.push(wholeChapter(BEFORE_BOOKMARKS_TITLE, lines.slice(0, starts[0]), words));
  }
  bookmarks.forEach((bookmark, index) => {
    const start = starts[index];
    const end = Math.max(start, index + 1 < starts.length ? starts[index + 1] : lines.length);
    chapters.push(bookmarkChapter(bookmark, lines, start, end, words));
  });
  return chapters;
}

/** PDF без закладок — книга одной главой. */
export function singleChapter(lines, words = bookWords(lines)) {
  return [wholeChapter(NO_BOOKMARKS_TITLE, lines, words)];
}

/**
 * PDF без закладок, заголовки найдены по крупному шрифту (pdf-headings.js). Части — того же вида,
 * что у закладок. Подглава до первой главы — глава сама по себе; заголовок INLINE текст не делит,
 * а стоит в нём строкой `###`. Строки заголовков в текст не идут.
 * @param {import('./pdf-text.js').Line[]} lines строки всей книги
 * @param {import('./pdf-headings.js').Heading[]} headings по порядку
 * @param {Set<string>} [words] словарь книги для склейки строк (bookWords из pdf-clean.js)
 * @returns {import('./chapters.js').Chapter[]}
 */
export function chaptersFromHeadings(lines, headings, words = bookWords(lines)) {
  const before = { title: BEFORE_HEADINGS_TITLE, blocks: [], sections: [] };
  const chapters = [];
  let chapter = null;
  let blocks = before.blocks;
  let from = 0;
  const flush = (to) => {
    if (to > from) blocks.push(...paragraphs(lines.slice(from, to), words));
  };
  for (const heading of headings) {
    flush(heading.start);
    from = heading.end;
    if (heading.level === INLINE) {
      blocks.push(`### ${heading.text}`);
    } else if (heading.level === CHAPTER || !chapter) {
      const own = { title: heading.text, blocks: [], sections: [] };
      chapters.push(own);
      if (heading.level === CHAPTER) chapter = own;
      blocks = own.blocks;
    } else {
      const section = { title: heading.text, blocks: [] };
      chapter.sections.push(section);
      blocks = section.blocks;
    }
  }
  flush(lines.length);
  if (before.blocks.length > 0) chapters.unshift(before);
  return chapters.map(headedChapter);
}

function wholeChapter(title, lines, words) {
  return { title, parts: [makePart('whole', title, [`# ${title}`, ...paragraphs(lines, words)])] };
}

function bookmarkChapter(bookmark, lines, start, end, words) {
  const title = cleanTitle(bookmark.title);
  // Напечатанный заголовок, совпадающий с закладкой, не повторяем: он уже в «#».
  const from = start < end && sameText(lines[start].text, title) ? start + 1 : start;
  const own = lines.slice(from, end);
  const head = `# ${title}`;
  if (bookmark.children.length === 0) {
    return { title, parts: [makePart('whole', title, [head, ...paragraphs(own, words)])] };
  }

  const sections = bookmark.children.map((child) => ({
    title: cleanTitle(child.title),
    index: Math.min(Math.max(lineAt(lines, child), from), end) - from,
  }));
  const parts = [];
  const intro = own.slice(0, sections[0].index);
  if (intro.length > 0) parts.push(makePart('intro', title, [head, ...paragraphs(intro, words)]));
  sections.forEach((section, index) => {
    const next = index + 1 < sections.length ? Math.max(section.index, sections[index + 1].index) : own.length;
    let body = own.slice(section.index, next);
    if (body.length > 0 && sameText(body[0].text, section.title)) body = body.slice(1);
    // Заголовок главы — в начале первой части главы, где бы она ни начиналась.
    const lead = parts.length === 0 ? [head] : [];
    parts.push(makePart('section', section.title, [...lead, `## ${section.title}`, ...paragraphs(body, words)]));
  });
  return { title, parts };
}

function headedChapter({ title, blocks, sections }) {
  const head = `# ${title}`;
  if (sections.length === 0) return { title, parts: [makePart('whole', title, [head, ...blocks])] };
  const parts = [];
  if (blocks.length > 0) parts.push(makePart('intro', title, [head, ...blocks]));
  for (const section of sections) {
    const lead = parts.length === 0 ? [head] : [];
    parts.push(makePart('section', section.title, [...lead, `## ${section.title}`, ...section.blocks]));
  }
  return { title, parts };
}

function makePart(kind, title, blocks) {
  const markdown = `${blocks.join('\n\n')}\n`;
  return { kind, title, markdown, words: countWords(markdown) };
}

// Первая строка, которая начинается на месте закладки или после него.
// Закладка указывает на верх строки, строка стоит на своей нижней линии:
// строка считается своей, если её середина не выше места закладки.
function lineAt(lines, { page, y }) {
  const index = lines.findIndex((line) => line.page > page
    || (line.page === page && (y === null || line.y - line.height / 2 <= y)));
  return index === -1 ? lines.length : index;
}

function cleanTitle(title) {
  return String(title ?? '').replace(/\s+/gu, ' ').trim() || UNTITLED;
}

function sameText(a, b) {
  const normalize = (text) => text.toLowerCase().replace(/\s+/gu, '');
  return normalize(a) === normalize(b);
}

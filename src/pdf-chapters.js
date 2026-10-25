// Строки PDF + закладки → главы и части (типы Chapter/Part из chapters.js).
// Главы и подглавы — по закладкам напрямую, без правила «повторяющийся уровень»:
// закладка верхнего уровня — глава, второго — подглава, даже если она одна;
// закладки глубже не делят текст и не дают заголовков.
import { paragraphs } from './pdf-text.js';
import { countWords } from './words.js';

export const NO_BOOKMARKS_TITLE = 'Текст';
// Текст до первой закладки (титул, аннотация) не выбрасывается: он идёт отдельной главой.
export const BEFORE_BOOKMARKS_TITLE = 'До первой закладки';
const UNTITLED = 'Без названия';

/**
 * Место закладки: страница (с 0) и, если назначение его даёт, высота на странице.
 * @typedef {{title: string, page: number, y: number | null, children: Bookmark[]}} Bookmark
 */

/**
 * @param {import('./pdf-text.js').Line[]} lines строки всей книги
 * @param {Bookmark[]} bookmarks закладки верхнего уровня, в порядке оглавления PDF
 * @returns {import('./chapters.js').Chapter[]}
 */
export function chaptersFromBookmarks(lines, bookmarks) {
  const starts = bookmarks.map((bookmark) => lineAt(lines, bookmark));
  const chapters = [];
  if (starts.length > 0 && starts[0] > 0) {
    chapters.push(wholeChapter(BEFORE_BOOKMARKS_TITLE, lines.slice(0, starts[0])));
  }
  bookmarks.forEach((bookmark, index) => {
    const start = starts[index];
    const end = Math.max(start, index + 1 < starts.length ? starts[index + 1] : lines.length);
    chapters.push(bookmarkChapter(bookmark, lines, start, end));
  });
  return chapters;
}

/** PDF без закладок — книга одной главой. */
export function singleChapter(lines) {
  return [wholeChapter(NO_BOOKMARKS_TITLE, lines)];
}

function wholeChapter(title, lines) {
  return { title, parts: [makePart('whole', title, [`# ${title}`, ...paragraphs(lines)])] };
}

function bookmarkChapter(bookmark, lines, start, end) {
  const title = cleanTitle(bookmark.title);
  // Напечатанный заголовок, совпадающий с закладкой, не повторяем: он уже в «#».
  const from = start < end && sameText(lines[start].text, title) ? start + 1 : start;
  const own = lines.slice(from, end);
  const head = `# ${title}`;
  if (bookmark.children.length === 0) {
    return { title, parts: [makePart('whole', title, [head, ...paragraphs(own)])] };
  }

  const sections = bookmark.children.map((child) => ({
    title: cleanTitle(child.title),
    index: Math.min(Math.max(lineAt(lines, child), from), end) - from,
  }));
  const parts = [];
  const intro = own.slice(0, sections[0].index);
  if (intro.length > 0) parts.push(makePart('intro', title, [head, ...paragraphs(intro)]));
  sections.forEach((section, index) => {
    const next = index + 1 < sections.length ? Math.max(section.index, sections[index + 1].index) : own.length;
    let body = own.slice(section.index, next);
    if (body.length > 0 && sameText(body[0].text, section.title)) body = body.slice(1);
    // Заголовок главы — в начале первой части главы, где бы она ни начиналась.
    const lead = parts.length === 0 ? [head] : [];
    parts.push(makePart('section', section.title, [...lead, `## ${section.title}`, ...paragraphs(body)]));
  });
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

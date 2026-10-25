// Заголовки PDF без закладок — по крупному шрифту (размер строки — поле size из pdf-text.js).
// Близкие размеры — одна группа; основной размер — группа, которой набрано больше всего букв книги.
// Уровень — группа, у которой есть два заголовка с разным текстом на разных страницах:
// самый крупный уровень — главы, следующий — подглавы, остальные заголовки текст не делят.
// Пороги — здесь, в одном месте: поправить по первой настоящей книге.
import { joinLines, removeSoftHyphens } from './pdf-clean.js';

// Размер входит в группу, если он меньше стольких наименьших размеров группы.
export const SAME_SIZE = 1.05;
// Строка заголовка набрана не мельче стольких основных размеров: Word набирает заголовки 14 при тексте 12.
export const HEADING_SIZE = 1.1;
// Допуск на округление при сравнении размеров: 13,2 при основном 12 — ровно 1,1 ×, а не меньше.
const ROUNDING = 1e-6;
// Строка заголовка — не длиннее стольких знаков.
export const MAX_HEADING_CHARS = 120;
// Больше стольких строк заголовка подряд — текст крупным шрифтом, а не заголовок.
export const MAX_HEADING_LINES = 3;

// Строка оглавления книги: номер страницы после отточия.
const TOC_LINE = /(\.{2,}|…)\s*\d+$/u;
const ARABIC = /^\d+$/u;
// Римские номера I…XXXIX.
const ROMAN = /^(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3})$/u;
// Строка из одной буквы — буквица; кроме римских номеров.
const ROMAN_LETTERS = new Set(['I', 'V', 'X']);

export const CHAPTER = 1;
export const SECTION = 2;
// Заголовок, который текст не делит: строка `###` на своём месте.
export const INLINE = 3;

/**
 * Заголовок: строки lines[start, end), его текст и уровень (CHAPTER, SECTION или INLINE).
 * @typedef {{start: number, end: number, text: string, level: number}} Heading
 */

/**
 * @param {import('./pdf-text.js').Line[]} lines строки всей книги, без колонтитулов и номеров страниц
 * @returns {Heading[]} по порядку; пусто — уровней нет, книга не делится
 */
export function findHeadings(lines) {
  const { groupOf, groupSizes } = sizeGroups(lines);
  const groups = lines.map((line) => groupOf.get(line.size));
  const mainSize = groupSizes[mainGroup(lines, groups)];
  const isHeadingLine = (line, index) => groupSizes[groups[index]] >= HEADING_SIZE * mainSize * (1 - ROUNDING)
    && [...line.text].length <= MAX_HEADING_CHARS
    && !isSingleLetter(line.text)
    && !TOC_LINE.test(line.text);

  // Подряд идущие строки заголовка одной группы на одной странице.
  const runs = [];
  for (let start = 0; start < lines.length;) {
    if (!isHeadingLine(lines[start], start)) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < lines.length && groups[end] === groups[start] && lines[end].page === lines[start].page
      && isHeadingLine(lines[end], end)) end += 1;
    if (end - start <= MAX_HEADING_LINES) {
      const texts = lines.slice(start, end).map((line) => line.text);
      runs.push({ start, end, page: lines[start].page, group: groups[start], texts });
    }
    start = end;
  }

  // Номер отдельной строкой — вместе со следующим заголовком той же страницы, группа — его.
  const merged = [];
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const next = runs[index + 1];
    if (run.texts.length === 1 && isNumber(run.texts[0]) && next && next.start === run.end && next.page === run.page) {
      merged.push({ ...next, start: run.start, text: `${run.texts[0]}. ${headingText(next.texts)}` });
      index += 1;
    } else {
      merged.push({ ...run, text: headingText(run.texts) });
    }
  }

  // Тот же текст, что у прошлого заголовка группы, — крупный колонтитул главы: остаётся текстом.
  const lastText = new Map();
  const headings = merged.filter((heading) => {
    const same = lastText.get(heading.group) === normalize(heading.text);
    lastText.set(heading.group, normalize(heading.text));
    return !same;
  });

  const levels = [...new Set(headings.map((heading) => heading.group))]
    .filter((group) => isLevel(headings.filter((heading) => heading.group === group)))
    .sort((a, b) => b - a);
  if (levels.length === 0) return [];
  return headings.map(({ start, end, text, group }) => ({
    start,
    end,
    text,
    level: group === levels[0] ? CHAPTER : group === levels[1] ? SECTION : INLINE,
  }));
}

// Группы размеров: по возрастанию, размер входит в группу, если меньше SAME_SIZE × её наименьшего.
// Размер группы — тот, которым в ней набрано больше букв; при равенстве — меньший.
function sizeGroups(lines) {
  const letters = new Map();
  for (const line of lines) letters.set(line.size, (letters.get(line.size) ?? 0) + countLetters(line.text));
  const groupOf = new Map();
  const groupSizes = [];
  let smallest = null;
  let most = -1;
  for (const size of [...letters.keys()].sort((a, b) => a - b)) {
    if (smallest === null || size >= SAME_SIZE * smallest) {
      smallest = size;
      most = -1;
      groupSizes.push(size);
    }
    groupOf.set(size, groupSizes.length - 1);
    if (letters.get(size) > most) {
      most = letters.get(size);
      groupSizes[groupSizes.length - 1] = size;
    }
  }
  return { groupOf, groupSizes };
}

// Основная группа — та, которой набрано больше всего букв книги; при равенстве — меньшая.
function mainGroup(lines, groups) {
  const letters = [];
  lines.forEach((line, index) => {
    letters[groups[index]] = (letters[groups[index]] ?? 0) + countLetters(line.text);
  });
  let main = 0;
  letters.forEach((count, group) => {
    if (count > (letters[main] ?? 0)) main = group;
  });
  return main;
}

function isLevel(headings) {
  return headings.some((a, index) => headings.slice(index + 1)
    .some((b) => a.page !== b.page && normalize(a.text) !== normalize(b.text)));
}

// Строки заголовка склеиваются как строки абзаца; после цифры или римского номера — через «. ».
function headingText(texts) {
  return removeSoftHyphens(texts.reduce((text, next) => (endsWithNumber(text) ? `${text}. ${next}` : joinLines(text, next))));
}

function endsWithNumber(text) {
  return /\d$/u.test(text) || ROMAN.test(text.split(' ').at(-1));
}

function isNumber(text) {
  return ARABIC.test(text) || ROMAN.test(text);
}

function isSingleLetter(text) {
  return [...text].length === 1 && /\p{L}/u.test(text) && !ROMAN_LETTERS.has(text);
}

function countLetters(text) {
  return [...text.replace(/\s+/gu, '')].length;
}

function normalize(text) {
  return text.toLowerCase().replace(/\s+/gu, '');
}

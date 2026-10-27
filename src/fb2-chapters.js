// Тела книги FB2 (fb2.js) → главы и части в той же раскладке, что у EPUB (Б-01, Б-14).
//
// Основной body — первый без name или с name, кроме notes и comments. Его секции верхнего
// уровня — главы, вложенные — подглавы NNN-01, NNN-02, … (текст до первой — NNN-00),
// глубже — заголовки «###». Текст body до первой секции — глава без заголовка. Обёртка
// (одна секция верхнего уровня, в ней две и больше вложенных) главой не считается: главы —
// её вложенные. Остальные body (примечания) — главами в конце, каждая одной частью.
import { fallbackTitle, renderPart } from './chapters.js';

const HAS_TEXT = /[\p{L}\p{N}]/u;
const NOT_MAIN = new Set(['notes', 'comments']);
const NOTES_TITLE = 'Примечания';

/**
 * @param {import('./fb2.js').Body[]} bodies по порядку файла
 * @returns {import('./chapters.js').Chapter[]} пустые секции и тела частями не становятся
 */
export function fb2Chapters(bodies) {
  const mainIndex = bodies.findIndex((body) => !NOT_MAIN.has(body.name));
  const chapters = mainIndex === -1 ? [] : mainChapters(bodies[mainIndex]);
  bodies.forEach((body, index) => {
    if (index !== mainIndex && hasText(body.items)) chapters.push(otherChapter(body));
  });
  return chapters;
}

function mainChapters(body) {
  let { lead, sections } = groups(body.items);
  const inner = sections.length === 1 ? groups(sections[0].section.items) : null;
  if (inner && inner.sections.length >= 2) {
    // Обёртка: её текст до первой вложенной — в главу с текстом body до секций, по порядку.
    lead = [...lead, ...inner.lead];
    inner.sections.at(-1).tail.push(...sections[0].tail);
    sections = inner.sections;
  }
  const chapters = [];
  if (hasText(lead)) {
    const title = firstWords(lead);
    chapters.push({ title, parts: [renderPart('whole', title, render(lead), [])] });
  }
  for (const { section, tail } of sections) chapters.push(sectionChapter(section, tail));
  return chapters;
}

// Секция верхнего уровня → глава: «#» — её заголовок в начале первой части.
function sectionChapter(section, tail) {
  const title = section.title ?? firstWords(section.items);
  const head = section.title ? [`# ${section.title}`] : [];
  const { lead, sections } = groups(section.items);
  if (sections.length === 0) {
    return { title, parts: [renderPart('whole', title, [...head, ...render([...lead, ...tail])], [])] };
  }
  const parts = [];
  // Перед первой вложенной только подзаголовки — они идут в начало первой подглавы.
  let carry = [...head, ...render(lead)];
  if (hasText(lead)) {
    parts.push(renderPart('intro', title, carry, []));
    carry = [];
  }
  sections.forEach(({ section: sub, tail: subTail }, index) => {
    const last = index === sections.length - 1;
    const lines = [...carry, ...(sub.title ? [`## ${sub.title}`] : []), ...flatten(sub.items),
      ...render(last ? [...subTail, ...tail] : subTail)];
    carry = [];
    parts.push(renderPart('section', sub.title ?? firstWords(sub.items), lines, []));
  });
  return { title, parts };
}

// Примечания и другие body — одна часть, секции любой глубины — «###».
function otherChapter(body) {
  const title = body.title ?? NOTES_TITLE;
  const lines = [...(body.title ? [`# ${body.title}`] : []), ...flatten(body.items)];
  return { title, parts: [renderPart('whole', title, lines, [])] };
}

/**
 * Содержимое → блоки до первой секции с текстом (lead) и секции с текстом; блоки после
 * секции — её хвост (tail). Пустые секции пропускаются, их хвост — к предыдущему.
 */
function groups(items) {
  const lead = [];
  const sections = [];
  for (const item of items) {
    if (item.type !== 'section') (sections.at(-1)?.tail ?? lead).push(item);
    else if (hasText(item.items)) sections.push({ section: item, tail: [] });
  }
  return { lead, sections };
}

// Блоки и секции любой глубины → строки markdown; заголовки секций — «###».
function flatten(items) {
  return items.flatMap((item) => {
    if (item.type !== 'section') return render([item]);
    if (!hasText(item.items)) return [];
    return [...(item.title ? [`### ${item.title}`] : []), ...flatten(item.items)];
  });
}

function render(blocks) {
  return blocks.map((block) => (block.type === 'heading' ? `### ${block.text}` : block.text));
}

function textBlocks(items) {
  return items.flatMap((item) => (item.type === 'section' ? textBlocks(item.items)
    : item.type === 'text' && HAS_TEXT.test(item.text) ? [item] : []));
}

function hasText(items) {
  return textBlocks(items).length > 0;
}

// Название без заголовка — первые слова текста.
function firstWords(items) {
  return fallbackTitle(textBlocks(items));
}

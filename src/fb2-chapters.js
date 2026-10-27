// Тела книги FB2 (fb2.js) → главы и части в той же раскладке, что у EPUB (Б-01, Б-14).
//
// Основной body — первый без name или с name, кроме notes и comments. Его секции верхнего
// уровня — главы, вложенные — подглавы NNN-01, NNN-02, … (текст до первой — NNN-00),
// глубже — заголовки «###». Текст body до первой секции — глава без заголовка. Обёртка
// (одна секция верхнего уровня, в ней две и больше вложенных) главой не считается: главы —
// её вложенные. Остальные body (примечания) — главами в конце, каждая одной частью.
//
// Сноски (Б-15): метки в тексте основного body получают номера в своей части, определения —
// в её конце. Примечание, чья метка попала в часть, уходит из body примечаний; body, где
// после этого не осталось текста, — в «Пропущено», как файл примечаний EPUB.
import { fallbackTitle, renderPart } from './chapters.js';
import { NOTES_BODIES } from './fb2.js';
import { markIds, plain } from './footnotes.js';
import { NOTES_REASON } from './import-epub.js';

const HAS_TEXT = /[\p{L}\p{N}]/u;
const NOTES_TITLE = 'Примечания';

/**
 * @param {import('./fb2.js').Body[]} bodies по порядку файла
 * @param {string[]} [notes] тексты сносок (readFb2), номер метки — индекс
 * @returns {{chapters: import('./chapters.js').Chapter[], skipped: {file: string, start: string, reason: string}[]}}
 *   пустые секции и тела частями не становятся; skipped — body примечаний, разнесённые по частям
 */
export function fb2Chapters(bodies, notes = []) {
  // Номера меток, которые попали в части: их примечания из body примечаний уходят.
  const used = new Set();
  const part = (kind, title, lines) => {
    for (const line of lines) for (const id of markIds(line)) used.add(id);
    return renderPart(kind, title, lines, notes);
  };
  const mainIndex = bodies.findIndex((body) => !NOTES_BODIES.has(body.name));
  const chapters = mainIndex === -1 ? [] : mainChapters(bodies[mainIndex], part);
  const skipped = [];
  bodies.forEach((body, index) => {
    if (index === mainIndex) return;
    const { items, cut } = withoutNotes(body.items, used);
    if (hasText(items)) chapters.push(otherChapter({ ...body, items }));
    else if (cut) skipped.push({ file: `body:${body.name}`, start: bodyStart(body), reason: NOTES_REASON });
  });
  return { chapters, skipped };
}

function mainChapters(body, part) {
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
    chapters.push({ title, parts: [part('whole', title, render(lead))] });
  }
  for (const { section, tail } of sections) chapters.push(sectionChapter(section, tail, part));
  return chapters;
}

// Секция верхнего уровня → глава: «#» — её заголовок в начале первой части.
// В оглавлении заголовок — без метки сноски.
function sectionChapter(section, tail, part) {
  const title = section.title === null ? firstWords(section.items) : plain(section.title);
  const head = section.title ? [`# ${section.title}`] : [];
  const { lead, sections } = groups(section.items);
  if (sections.length === 0) {
    return { title, parts: [part('whole', title, [...head, ...render([...lead, ...tail])])] };
  }
  const parts = [];
  // Перед первой вложенной только подзаголовки — они идут в начало первой подглавы.
  let carry = [...head, ...render(lead)];
  if (hasText(lead)) {
    parts.push(part('intro', title, carry));
    carry = [];
  }
  sections.forEach(({ section: sub, tail: subTail }, index) => {
    const last = index === sections.length - 1;
    const lines = [...carry, ...(sub.title ? [`## ${sub.title}`] : []), ...flatten(sub.items),
      ...render(last ? [...subTail, ...tail] : subTail)];
    carry = [];
    parts.push(part('section', sub.title ?? firstWords(sub.items), lines));
  });
  return { title, parts };
}

// Примечания и другие body — одна часть, секции любой глубины — «###».
function otherChapter(body) {
  const title = body.title ?? NOTES_TITLE;
  const lines = [...(body.title ? [`# ${body.title}`] : []), ...flatten(body.items)];
  return { title, parts: [renderPart('whole', title, lines, [])] };
}

// Содержимое без секций-примечаний, чьи метки попали в части; cut — что-то ушло.
function withoutNotes(items, used) {
  let cut = false;
  const filter = (list) => list.flatMap((item) => {
    if (item.type !== 'section') return [item];
    if (used.has(item.noteId)) {
      cut = true;
      return [];
    }
    return [{ ...item, items: filter(item.items) }];
  });
  const kept = filter(items);
  return { items: kept, cut };
}

// Первые слова body до вырезания примечаний, с заголовками, — как у файла примечаний EPUB.
function bodyStart(body) {
  const lines = (items) => items.flatMap((item) => (item.type === 'section'
    ? [...(item.title ? [{ text: item.title }] : []), ...lines(item.items)] : [item]));
  const blocks = [...(body.title ? [{ text: body.title }] : []), ...lines(body.items)];
  return blocks.some((block) => HAS_TEXT.test(block.text)) ? fallbackTitle(blocks) : '';
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

// Сноски внутри документа (Б-07): ссылка в абзаце ведёт на примечание в том же файле.
// Примечание вырезается из текста главы, на месте ссылки встаёт метка, а текст
// примечания уходит определением в конец части: `слово[^1]` … `[^1]: текст`.
// Здесь — поиск сносок в разметке и запись меток в части; текст примечания
// собирает html-to-blocks.js. Сноски из другого файла книги здесь не разбираются.
import path from 'node:path';
import { epubTypes, resolveHref } from './epub.js';

const ELEMENT = 1;
const TEXT = 3;

const BLOCK = new Set([
  'html', 'body', 'main', 'article', 'section', 'nav', 'aside', 'header', 'footer',
  'div', 'p', 'blockquote', 'pre', 'hr', 'address', 'center', 'figure', 'figcaption',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const NOT_CONTENT = new Set(['script', 'style', 'noscript', 'template']);
// Обёртки примечаний: остались одни заголовки и <hr> — вырезаются вместе с ними.
const WRAPPERS = new Set(['section', 'div', 'aside', 'footer', 'ol', 'ul']);
const SIGN = /^(\[\d{1,3}\]|\d{1,3}|\*{1,3}|†|‡)$/;
const HAS_TEXT = /\S/;

// До раскладки по частям метка — один символ из частной области Юникода с номером
// примечания в документе: не буква и не цифра, поэтому слов не добавляет.
const MARK_BASE = 0xF0000;
const MARKS = /[\u{F0000}-\u{FFFFD}]/gu;
export const SPACE_BEFORE_MARK = /[^\S\n]+(?=[\u{F0000}-\u{FFFFD}])/gu;

const DEFINITION = /^\[\^\d+\]: /;
const BLANK = /^\s*$/;

/** Метка примечания с номером index (с 0) в тексте блоков документа. */
export function noteMark(index) {
  return String.fromCodePoint(MARK_BASE + index);
}

/** Текст без меток сносок — для оглавления в book.md. */
export function stripNoteMarks(text) {
  return text.replace(MARKS, '');
}

/**
 * Сноски документа по порядку и все обратные ссылки (их текст в примечание не идёт).
 * @param {import('node-html-parser').HTMLElement} body
 * @param {string} [href] путь документа в книге: ссылка «этот-файл.xhtml#id» — тоже на него
 * @returns {{footnotes: {link: import('node-html-parser').HTMLElement, note: import('node-html-parser').HTMLElement}[],
 *   backlinks: Set<import('node-html-parser').HTMLElement>}}
 */
export function findFootnotes(body, href) {
  const ids = new Map();
  for (const element of body.querySelectorAll('*')) {
    const id = element.getAttribute('id') ?? (tagOf(element) === 'a' ? element.getAttribute('name') : undefined);
    if (id && !ids.has(id)) ids.set(id, element);
  }

  const candidates = [];
  const backlinks = new Set();
  for (const link of body.querySelectorAll('a')) {
    const target = ids.get(fragmentOf(link.getAttribute('href'), href));
    if (!target) continue;
    if (isBacklink(link, target)) {
      backlinks.add(link);
      continue;
    }
    const note = noteOf(target);
    if (note && isNoteref(link) && isNote(note, link)) candidates.push({ link, note });
  }

  // Ссылка внутри примечания другой сноски — часть его текста, а не сноска.
  // Сноска в начале абзаца, на который ведёт ссылка из её примечания, от
  // примечания не отличима: такая пара остаётся текстом.
  const containers = new Map(candidates.map((candidate) => [
    candidate,
    candidates.filter((other) => other !== candidate && isInside(candidate.link, other.note)),
  ]));
  const mutual = new Set(candidates.filter((candidate) =>
    containers.get(candidate).some((other) => containers.get(other).includes(candidate))));
  const effective = new Map();
  const isEffective = (candidate) => {
    if (!effective.has(candidate)) {
      effective.set(candidate, false);
      effective.set(candidate, !mutual.has(candidate) && !containers.get(candidate).some(isEffective));
    }
    return effective.get(candidate);
  };
  return { footnotes: candidates.filter(isEffective), backlinks };
}

/**
 * Вырезает примечание из текста; обёртка, где остались одни заголовки, <hr> и
 * пустота, уходит вместе с ним — и так вверх, пока снимается.
 */
export function cutNote(note) {
  let parent = note.parentNode;
  note.remove();
  while (parent && WRAPPERS.has(tagOf(parent)) && onlyChrome(parent)) {
    const up = parent.parentNode;
    parent.remove();
    parent = up;
  }
}

/**
 * Метки в тексте части → `[^N]` по первому появлению, определения — блоком в конце.
 * @param {string} markdown текст части с метками документа, кончается переносом строки
 * @param {string[]} notes тексты примечаний документа по номеру метки
 * @returns {{markdown: string, notes: string[]}} notes — тексты определений части по порядку
 */
export function placeNotes(markdown, notes) {
  const numbers = new Map();
  const text = markdown.replace(MARKS, (mark) => {
    const index = mark.codePointAt(0) - MARK_BASE;
    if (!numbers.has(index)) numbers.set(index, numbers.size + 1);
    return `[^${numbers.get(index)}]`;
  });
  if (numbers.size === 0) return { markdown: text, notes: [] };
  const used = [...numbers.keys()].map((index) => notes[index]);
  const definitions = used.map((note, i) => `[^${i + 1}]: ${note}`);
  return { markdown: `${text}\n${definitions.join('\n')}\n`, notes: used };
}

/** Блок определений сносок (Б-07): каждая его строка начинается с `[^N]: `. */
export function isNoteDefinitions(text) {
  return text.split('\n').every((line) => DEFINITION.test(line));
}

/** Число определений сносок в файле части — строк блока определений в его конце. */
export function countNoteDefinitions(markdown) {
  const lines = markdown.split(/\r?\n/);
  while (lines.length && BLANK.test(lines.at(-1))) lines.pop();
  let count = 0;
  while (count < lines.length && DEFINITION.test(lines[lines.length - 1 - count])) count += 1;
  const before = lines[lines.length - 1 - count];
  return before === undefined || BLANK.test(before) ? count : 0;
}

// id цели, если ссылка ведёт внутрь этого же документа: «#id» или «этот-файл.xhtml#id».
function fragmentOf(value, href) {
  const hash = value?.indexOf('#') ?? -1;
  if (hash < 0) return undefined;
  const file = value.slice(0, hash);
  if (file && !(href && resolveHref(path.posix.dirname(href), file) === href)) return undefined;
  try {
    return decodeURIComponent(value.slice(hash + 1));
  } catch {
    return value.slice(hash + 1);
  }
}

// Обратная ссылка размечена так — или ведёт на место сноски в абзаце: непустой
// строчный элемент, перед которым в его блоке есть текст.
function isBacklink(link, target) {
  if (epubTypes(link).includes('backlink') || roles(link).includes('doc-backlink')) return true;
  return !BLOCK.has(tagOf(target)) && HAS_TEXT.test(target.text) && hasTextBefore(target);
}

function isNoteref(link) {
  if (epubTypes(link).includes('noteref') || roles(link).includes('doc-noteref')) return true;
  return SIGN.test(link.text.replace(/\s/g, '')) && (link.closest('sup') !== null || link.querySelector('sup') !== null);
}

// Примечание — сама цель, если она блочная; пустая или строчная цель без текста
// перед ней — ближайший блочный родитель.
function noteOf(target) {
  if (BLOCK.has(tagOf(target))) return target;
  if (hasTextBefore(target)) return null;
  return blockOf(target);
}

function isNote(note, link) {
  const tag = tagOf(note);
  if (tag === 'body' || tag === 'html' || HEADINGS.has(tag)) return false;
  if (note.querySelector('h1, h2, h3, h4, h5, h6')) return false;
  return !isInside(link, note);
}

function blockOf(node) {
  let parent = node.parentNode;
  while (parent && !BLOCK.has(tagOf(parent))) parent = parent.parentNode;
  return parent;
}

function hasTextBefore(target) {
  const block = blockOf(target);
  if (!block) return false;
  // true — текст встретился раньше цели, false — дошли до цели без текста.
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child === target) return false;
      if (child.nodeType === TEXT && HAS_TEXT.test(child.text)) return true;
      if (child.nodeType === ELEMENT && !NOT_CONTENT.has(tagOf(child))) {
        const found = walk(child);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return walk(block) === true;
}

function onlyChrome(element) {
  return element.childNodes.every((child) => {
    if (child.nodeType === TEXT) return !HAS_TEXT.test(child.text);
    if (child.nodeType !== ELEMENT) return true;
    const tag = tagOf(child);
    return HEADINGS.has(tag) || tag === 'hr' || !HAS_TEXT.test(child.text);
  });
}

function isInside(node, ancestor) {
  for (let current = node; current; current = current.parentNode) {
    if (current === ancestor) return true;
  }
  return false;
}

function roles(element) {
  return (element.getAttribute('role') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

function tagOf(element) {
  return (element.rawTagName ?? '').toLowerCase();
}

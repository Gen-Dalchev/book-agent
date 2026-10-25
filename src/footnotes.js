// Сноски: ссылка на примечание в том же документе или в другом документе книги
// (отдельный файл примечаний) становится меткой в тексте, а само примечание уходит
// из своего документа и ложится определением в конец части, где метка. Признаки
// сноски и обратной ссылки — по задаче #16 (решение Б-07), другой файл — по #26.
//
// Разбор идёт по дереву документа до превращения в блоки: он правит дерево
// (ссылка → метка, примечание вырезано) и отдаёт тексты примечаний. Метка в тексте
// блоков — служебные знаки из области частного употребления; номера [^N] ей назначает
// часть (numberMarks), потому что нумерация своя в каждой части.
import path from 'node:path';
import { TextNode } from 'node-html-parser';
import { resolveHref } from './epub.js';
import { ELEMENT, TEXT, HEADING_LEVELS, SKIP, BLOCK, tagOf } from './html-tags.js';

const MARK_OPEN = '\uE000';
const MARK_CLOSE = '\uE001';
const DIGIT_BASE = 0xe010;
// Пробелы перед меткой (в том числе неразрывные, но не перенос строки) в текст не идут.
const MARK = /([^\S\n]*)\uE000([\uE010-\uE019]+)\uE001/g;

const SIGN = /^(\[\d{1,3}\]|\d{1,3}[.)]?|\*{1,3}|†|‡)$/;
const NOTE_BLOCKS = new Set(['p', 'li', 'dd', 'aside', 'div', 'section']);
const WRAPPERS = new Set(['section', 'div', 'aside', 'footer', 'ol', 'ul']);
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Метка сноски номер id в тексте блока. */
function markFor(id) {
  const digits = [...String(id)].map((digit) => String.fromCharCode(DIGIT_BASE + Number(digit)));
  return `${MARK_OPEN}${digits.join('')}${MARK_CLOSE}`;
}

/** Текст блока без меток — для заголовков в оглавлении и первых слов страницы. */
export function plain(text) {
  return text.replace(MARK, '');
}

/**
 * Метки в текстах одной части → [^N] по первому появлению, с 1; повторная ссылка на
 * ту же сноску — та же метка. Тексты идут в порядке файла части, заголовки тоже.
 * @param {string[]} texts
 * @param {string[]} notes тексты сносок документа; номер метки в тексте — индекс
 * @returns {{texts: string[], definitions: string[]}} definitions — строки «[^N]: текст» по возрастанию N
 */
export function numberMarks(texts, notes) {
  const labels = new Map();
  const definitions = [];
  const numbered = texts.map((text) => text.replace(MARK, (_whole, _space, digits) => {
    const id = Number([...digits].map((char) => char.charCodeAt(0) - DIGIT_BASE).join(''));
    if (!labels.has(id)) {
      labels.set(id, labels.size + 1);
      definitions.push(`[^${labels.size}]: ${notes[id]}`);
    }
    return `[^${labels.get(id)}]`;
  }));
  return { texts: numbered, definitions };
}

/**
 * Правит дерево документа: ссылки-сноски заменяются метками, примечания вырезаются
 * (вместе с обёрткой, в которой больше ничего нет).
 * @param {import('node-html-parser').HTMLElement} body
 * @param {object} options
 * @param {string | null} [options.href] путь документа в архиве; без него ссылки с именем файла не разбираются
 * @param {(element: import('node-html-parser').HTMLElement, hidden: Set<object>) => string} options.render
 *   текст содержимого элемента как в абзаце; hidden — узлы, которые не выводить
 * @returns {{notes: string[]}} тексты сносок; номер сноски — индекс
 */
export function extractFootnotes(body, { href = null, render }) {
  return { notes: extractBookFootnotes([{ href, body }], { render })[0].notes };
}

/**
 * То же для всех документов книги разом (задача #26): цель сноски может лежать
 * в другом документе — отдельном файле примечаний. Сначала собираются кандидаты
 * по всем документам, потом вырезаются примечания: ссылка внутри примечания,
 * которое уйдёт из любого документа, не разбирается.
 * @param {{href: string | null, body: import('node-html-parser').HTMLElement}[]} documents в порядке чтения
 * @param {object} options
 * @param {(element: import('node-html-parser').HTMLElement, hidden: Set<object>) => string} options.render
 * @param {Set<string>} [options.closed] служебные документы: ссылка в них из другого документа — не сноска
 * @returns {{notes: string[], notesFile: boolean}[]} по документу: тексты его сносок (номер — индекс);
 *   notesFile — из документа вырезано примечание по сноске из другого документа
 */
export function extractBookFootnotes(documents, { render, closed = new Set() }) {
  const docs = documents.map(({ href, body }, index) => {
    const elements = descendants(body);
    const ids = new Map();
    for (const element of elements) {
      const id = element.getAttribute('id');
      if (id && !ids.has(id)) ids.set(id, element);
      const name = tagOf(element) === 'a' ? element.getAttribute('name') : null;
      if (name && !ids.has(name)) ids.set(name, element);
    }
    const links = elements.filter((element) => tagOf(element) === 'a' && element.getAttribute('href'));
    return { index, href, ids, links, notes: [], idOf: new Map(), notesFile: false };
  });
  const byHref = new Map();
  for (const doc of docs) {
    if (doc.href !== null && !byHref.has(doc.href)) byHref.set(doc.href, doc);
  }

  // Документ и id, куда ведёт ссылка: свой документ, другой из порядка чтения или никуда.
  const pointOf = (link, doc) => {
    const value = link.getAttribute('href');
    const hash = value.indexOf('#');
    if (hash === -1) return null;
    const file = value.slice(0, hash);
    let to = doc;
    if (file !== '') {
      if (doc.href === null || URL_SCHEME.test(file)) return null;
      const resolved = resolveHref(path.posix.dirname(doc.href), file);
      to = resolved === doc.href ? doc : byHref.get(resolved);
      if (!to) return null;
    }
    return { doc: to, fragment: decodeFragment(value.slice(hash + 1)) };
  };
  const targetOf = (link, doc) => {
    const point = pointOf(link, doc);
    const target = point?.fragment ? point.doc.ids.get(point.fragment) : undefined;
    return target && target !== link ? { doc: point.doc, target } : null;
  };

  // Сначала все обратные ссылки: из текста примечания они убираются. Для каждой
  // запомнен документ, куда она ведёт.
  const backlinks = new Map();
  for (const doc of docs) {
    for (const link of doc.links) {
      const found = targetOf(link, doc);
      if (hasWord(link, 'epub:type', 'backlink') || hasWord(link, 'role', 'doc-backlink')
        || (found && isPlace(found.target))) {
        backlinks.set(link, pointOf(link, doc)?.doc ?? null);
      }
    }
  }
  const hidden = new Set(backlinks.keys());
  // Примечание в другом документе, найденное через якорь в начале блока, должно
  // вести обратно: иначе это абзац главы, а не примечание.
  const leadsBack = (note, doc) => descendants(note).some((element) => backlinks.get(element) === doc);

  const candidates = [];
  const rawTexts = new Map();
  for (const doc of docs) {
    for (const link of doc.links) {
      if (backlinks.has(link) || !isNoteref(link) || insideSkipped(link)) continue;
      const found = targetOf(link, doc);
      if (!found) continue;
      const other = found.doc !== doc;
      if (other && closed.has(found.doc.href)) continue;
      const note = noteOf(found.target);
      if (!note || !isAcceptable(note, link)) continue;
      if (other && note !== found.target && !leadsBack(note, doc)) continue;
      if (!rawTexts.has(note)) rawTexts.set(note, noteText(render(note, hidden)));
      const sign = signOf(link);
      const text = stripSign(rawTexts.get(note), sign) || rawTexts.get(note);
      if (!text) continue;
      candidates.push({ doc, link, note, noteDoc: found.doc, text });
    }
  }

  // Ссылка внутри примечания, которое уйдёт из текста, не разбирается: её текст остаётся.
  const cut = new Set(candidates.map((candidate) => candidate.note));
  const accepted = candidates.filter(({ link }) => !hasAncestorIn(link, cut));

  // Номера сносок — свои в каждом документе: одно примечание из двух глав — в каждой своё.
  for (const { doc, link, note, noteDoc, text } of accepted) {
    if (!doc.idOf.has(note)) {
      doc.idOf.set(note, doc.notes.length);
      doc.notes.push(text);
    }
    link.set_content(new TextNode(markFor(doc.idOf.get(note)), link));
    if (noteDoc !== doc) noteDoc.notesFile = true;
  }

  const marked = new Set(accepted.map((candidate) => candidate.link));
  const parents = [];
  for (const note of new Set(accepted.map((candidate) => candidate.note))) {
    if (!note.parentNode) continue;
    parents.push(note.parentNode);
    note.remove();
  }
  for (const parent of parents) cutEmptyWrappers(parent, marked);
  return docs.map(({ notes, notesFile }) => ({ notes, notesFile }));
}

function descendants(root) {
  const out = [];
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== ELEMENT) continue;
      out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment; // не закодировано — берём как есть
  }
}

function hasWord(element, attribute, word) {
  return (element.getAttribute(attribute) ?? '').toLowerCase().split(/\s+/).includes(word);
}

function isNoteref(link) {
  if (hasWord(link, 'epub:type', 'noteref') || hasWord(link, 'role', 'doc-noteref')) return true;
  return SIGN.test(linkText(link)) && (hasAncestor(link, 'sup') || descendants(link).some((el) => tagOf(el) === 'sup'));
}

function linkText(link) {
  return link.text.replace(/\s+/g, '');
}

// Знак сноски без скобок и точки: «[1]», «1)», «1.» → «1». Слова («примечание») знаком не считаются.
function signOf(link) {
  const text = linkText(link);
  return SIGN.test(text) ? text.replace(/[[\]]/g, '').replace(/^(\d+)[.)]$/, '$1') : '';
}

// Место сноски в тексте: непустой строчный элемент, перед которым в его блоке есть текст.
// Ссылка на него — обратная.
function isPlace(target) {
  return !BLOCK.has(tagOf(target)) && /\S/.test(target.text) && hasTextBefore(target);
}

function noteOf(target) {
  const tag = tagOf(target);
  if (NOTE_BLOCKS.has(tag)) return target;
  if (BLOCK.has(tag)) return null;
  if (hasTextBefore(target)) return null;
  return closestBlock(target);
}

function isAcceptable(note, link) {
  const tag = tagOf(note);
  if (!tag || tag === 'body' || tag === 'html') return false;
  if (Object.hasOwn(HEADING_LEVELS, tag)) return false;
  if (descendants(note).some((element) => Object.hasOwn(HEADING_LEVELS, tagOf(element)))) return false;
  return !hasAncestorIn(link, new Set([note]));
}

function insideSkipped(element) {
  for (let node = element.parentNode; node; node = node.parentNode) {
    if (SKIP.has(tagOf(node)) || tagOf(node) === 'pre') return true;
  }
  return false;
}

function closestBlock(element) {
  let node = element.parentNode;
  while (node.parentNode && !BLOCK.has(tagOf(node))) node = node.parentNode;
  return node;
}

function hasTextBefore(target) {
  let found = false;
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child === target) return true;
      if (child.nodeType === TEXT) {
        if (/\S/.test(child.text)) found = true;
      } else if (child.nodeType === ELEMENT && !SKIP.has(tagOf(child)) && walk(child)) {
        return true;
      }
      if (found) return false;
    }
    return false;
  };
  walk(closestBlock(target));
  return found;
}

function hasAncestor(element, tag) {
  for (let node = element.parentNode; node; node = node.parentNode) {
    if (tagOf(node) === tag) return true;
  }
  return false;
}

function hasAncestorIn(element, set) {
  for (let node = element.parentNode; node; node = node.parentNode) {
    if (set.has(node)) return true;
  }
  return false;
}

// Курсив и жирный — как в абзацах; блоки и переносы строк — через один пробел.
function noteText(rendered) {
  return rendered
    .replace(/[ \t\r\f]*\n[ \t\r\f\n]*/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Один ведущий знак, совпадающий со знаком сноски: «1», «[1]», «1.», «1)».
// «12 апреля» при знаке «1» знаком не открывается.
function stripSign(text, sign) {
  if (!sign) return text;
  const escaped = sign.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^(?:\\[${escaped}\\]|${escaped}[.)]?)`));
  if (!match) return text;
  if (/^\d/.test(sign) && /^\d/.test(text.slice(match[0].length))) return text;
  return text.slice(match[0].length).trim();
}

// Вырезанное примечание могло быть единственным содержимым обёртки («Примечания»:
// section > hr + h2 + ol > li). Обёртка, где остались только заголовки, <hr> и пустота,
// уходит целиком; дальше — вверх, пока снимается. Обёртку со ссылкой-сноской не трогаем.
function cutEmptyWrappers(start, links) {
  let wrapper = start;
  while (wrapper && wrapper.parentNode && WRAPPERS.has(tagOf(wrapper))
    && !hasLeftovers(wrapper) && ![...links].some((link) => hasAncestorIn(link, new Set([wrapper])))) {
    const parent = wrapper.parentNode;
    wrapper.remove();
    wrapper = parent;
  }
}

function hasLeftovers(element) {
  for (const child of element.childNodes) {
    if (child.nodeType === TEXT) {
      if (/\S/.test(child.text)) return true;
    } else if (child.nodeType === ELEMENT) {
      const tag = tagOf(child);
      if (Object.hasOwn(HEADING_LEVELS, tag) || tag === 'hr' || SKIP.has(tag)) continue;
      if (hasLeftovers(child)) return true;
    }
  }
  return false;
}

// XHTML главы → плоский список блоков: заголовки (с уровнем из h1–h6) и текстовые
// блоки в markdown (абзацы, списки, цитаты). Простой обход дерева: курсив и жирный
// сохраняются, картинки, стили и скрипты отбрасываются, остальное — текстом.
// Сноски внутри документа (footnotes.js): примечание вырезается, его текст — в notes,
// на месте ссылки — метка с номером примечания; номера сносок ставит часть (chapters.js).
import { parse, TextNode } from 'node-html-parser';
import { cutNote, findFootnotes, noteMark, SPACE_BEFORE_MARK } from './footnotes.js';

const ELEMENT = 1;
const TEXT = 3;

const HEADING_LEVELS = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const SKIP = new Set([
  'head', 'title', 'script', 'style', 'noscript', 'template', 'svg', 'math',
  'img', 'image', 'picture', 'audio', 'video', 'object', 'embed', 'iframe', 'canvas',
  'input', 'button', 'select', 'textarea',
]);
const BLOCK = new Set([
  'html', 'body', 'main', 'article', 'section', 'nav', 'aside', 'header', 'footer',
  'div', 'p', 'blockquote', 'pre', 'hr', 'address', 'center', 'figure', 'figcaption',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);
const ITALIC = new Set(['em', 'i', 'cite', 'dfn', 'var']);
const BOLD = new Set(['strong', 'b']);
const CODE = new Set(['code', 'kbd', 'samp', 'tt']);

// Пробелы HTML схлопываются, а неразрывный пробел (U+00A0) и прочие — нет:
// текст должен совпасть с исходным посимвольно.
const HTML_SPACE = /[ \t\n\r\f]+/g;
const EDGE_SPACE = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g;

/**
 * @param {string} html
 * @param {{href?: string}} [options] href — путь документа в книге, для ссылок «этот-файл.xhtml#id»
 * @returns {{title: string, blocks: ({type: 'heading', level: number, text: string} | {type: 'text', text: string})[],
 *   notes: string[]}} notes — тексты сносок документа по номеру метки в блоках
 */
export function htmlToBlocks(html, { href } = {}) {
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: { script: true, style: true },
  });
  const title = cleanInline(root.querySelector('title')?.text ?? '').replace(/\n/g, ' ');
  const body = root.querySelector('body') ?? root;
  const notes = takeFootnotes(body, href);
  const blocks = [];
  collectBlocks(body, blocks);
  return { title, blocks, notes };
}

function takeFootnotes(body, href) {
  const { footnotes, backlinks } = findFootnotes(body, href);
  const numbers = new Map();
  const notes = [];
  for (const { link, note } of footnotes) {
    if (numbers.has(note)) continue;
    numbers.set(note, notes.length);
    notes.push(noteText(note, link, backlinks));
  }
  for (const note of numbers.keys()) cutNote(note);
  for (const { link, note } of footnotes) {
    link.replaceWith(new TextNode(noteMark(numbers.get(note)), link.parentNode));
  }
  return notes;
}

// Текст примечания — одной строкой, без обратных ссылок и без ведущего знака
// сноски («1», «[1]», «1.», «1)»).
function noteText(note, link, backlinks) {
  for (const anchor of note.querySelectorAll('a')) {
    if (backlinks.has(anchor)) anchor.remove();
  }
  const text = cleanInline(renderInline(note).replace(/\n/g, ' '));
  const sign = link.text.replace(/\s/g, '').replace(/^\[(.*)\]$/, '$1');
  if (!sign) return text;
  const escaped = sign.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = new RegExp(`^(?:\\[${escaped}\\]|${escaped}[.)]?)(?![\\p{L}\\p{N}*.)])`, 'u');
  return text.replace(lead, '').replace(EDGE_SPACE, '');
}

function collectBlocks(element, out) {
  let inline = [];
  const flush = () => {
    const text = cleanInline(inline.join(''));
    inline = [];
    if (text) out.push({ type: 'text', text });
  };
  for (const child of element.childNodes) {
    if (child.nodeType === TEXT) {
      inline.push(collapse(child.text));
    } else if (child.nodeType === ELEMENT && !SKIP.has(tagOf(child))) {
      if (isBlockish(child)) {
        flush();
        renderBlock(child, out);
      } else {
        inline.push(renderInline(child));
      }
    }
  }
  flush();
}

function renderBlock(element, out) {
  const tag = tagOf(element);
  if (tag in HEADING_LEVELS) {
    const text = cleanInline(renderChildren(element)).replace(/\n/g, ' ');
    if (text) out.push({ type: 'heading', level: HEADING_LEVELS[tag], text });
  } else if (tag === 'p' && !hasBlockChildren(element)) {
    const text = cleanInline(renderChildren(element));
    if (text) out.push({ type: 'text', text });
  } else if (tag === 'ul' || tag === 'ol') {
    const lines = renderList(element, '');
    if (lines.length) out.push({ type: 'text', text: lines.join('\n') });
  } else if (tag === 'blockquote') {
    const inner = [];
    collectBlocks(element, inner);
    const text = inner
      .map((block) => block.text.split('\n').map((line) => `> ${line}`).join('\n'))
      .join('\n>\n');
    if (text) out.push({ type: 'text', text });
  } else if (tag === 'pre') {
    const text = element.text.replace(/^\n|\n+$/g, '');
    if (text.trim()) out.push({ type: 'text', text: '```\n' + text + '\n```' });
  } else if (tag === 'hr') {
    out.push({ type: 'text', text: '---' });
  } else if (tag === 'table') {
    const lines = tableRows(element)
      .map((row) => row.map((cell) => cleanInline(renderChildren(cell)).replace(/\n/g, ' ')).join(' | '))
      .filter((line) => line.replace(/[ |]/g, ''));
    if (lines.length) out.push({ type: 'text', text: lines.join('\n') });
  } else {
    collectBlocks(element, out);
  }
}

function renderList(list, indent) {
  const ordered = tagOf(list) === 'ol';
  let number = Number.parseInt(list.getAttribute('start') ?? '', 10);
  if (!Number.isFinite(number)) number = 1;
  const lines = [];
  for (const item of list.childNodes) {
    if (item.nodeType !== ELEMENT || tagOf(item) !== 'li') continue;
    const marker = ordered ? `${number++}. ` : '- ';
    const nested = [];
    const inline = [];
    for (const child of item.childNodes) {
      const tag = child.nodeType === ELEMENT ? tagOf(child) : null;
      if (tag === 'ul' || tag === 'ol') {
        nested.push(...renderList(child, indent + ' '.repeat(marker.length)));
      } else {
        inline.push(renderInline(child));
      }
    }
    const text = cleanInline(inline.join(''));
    if (text) {
      const pad = indent + ' '.repeat(marker.length);
      lines.push(indent + marker + text.replace(/\n/g, `\n${pad}`));
    }
    lines.push(...nested);
  }
  return lines;
}

function tableRows(table) {
  const rows = [];
  const walk = (element) => {
    for (const child of element.childNodes) {
      if (child.nodeType !== ELEMENT) continue;
      const tag = tagOf(child);
      if (tag === 'tr') {
        rows.push(child.childNodes.filter((cell) => cell.nodeType === ELEMENT && ['td', 'th'].includes(tagOf(cell))));
      } else if (['thead', 'tbody', 'tfoot'].includes(tag)) {
        walk(child);
      }
    }
  };
  walk(table);
  return rows;
}

function renderInline(node, style = {}) {
  if (node.nodeType === TEXT) return collapse(node.text);
  if (node.nodeType !== ELEMENT) return '';
  const tag = tagOf(node);
  if (SKIP.has(tag)) return '';
  if (tag === 'br') return '\n';
  if (ITALIC.has(tag) && !style.italic) {
    return wrap(renderChildren(node, { ...style, italic: true }), '*');
  }
  if (BOLD.has(tag) && !style.bold) {
    return wrap(renderChildren(node, { ...style, bold: true }), '**');
  }
  if (CODE.has(tag) && !style.code) {
    return wrap(renderChildren(node, { ...style, code: true }), '`');
  }
  // Блочный элемент внутри строки (абзац в заголовке, в ячейке) — через пробел.
  if (BLOCK.has(tag)) return ` ${renderChildren(node, style)} `;
  return renderChildren(node, style);
}

function renderChildren(element, style = {}) {
  return element.childNodes.map((child) => renderInline(child, style)).join('');
}

// Пробелы по краям выносятся за маркеры: «* слово *» markdown не поймёт.
function wrap(inner, marker) {
  const [, lead, core, trail] = inner.match(/^([ \t\n\r\f]*)([\s\S]*?)([ \t\n\r\f]*)$/);
  if (!core) return inner;
  return `${lead}${marker}${core}${marker}${trail}`;
}

function collapse(text) {
  return text.replace(HTML_SPACE, ' ');
}

// Внутри блока пустых строк нет: пустая строка делит абзацы (Б-04), а один абзац
// исходника — один ¶. Поэтому <br><br> и строфы в одном <p> — один перенос; пустой
// считается и строка из одних пробелов, в том числе неразрывных. Метка сноски
// прилегает к слову: пробелы перед ней убираются.
function cleanInline(text) {
  return text
    .replace(SPACE_BEFORE_MARK, '')
    .replace(/ *\n */g, '\n')
    .replace(/\n(?:[^\S\n]*\n)+/g, '\n')
    .replace(/ {2,}/g, ' ')
    .replace(EDGE_SPACE, '');
}

const blockishCache = new WeakMap();

// Блочный — сам блочный тег или строчный, внутри которого есть блоки (<a><p>…</p></a>).
function isBlockish(element) {
  if (blockishCache.has(element)) return blockishCache.get(element);
  const result = BLOCK.has(tagOf(element)) || hasBlockChildren(element);
  blockishCache.set(element, result);
  return result;
}

function hasBlockChildren(element) {
  return element.childNodes.some(
    (child) => child.nodeType === ELEMENT && !SKIP.has(tagOf(child)) && isBlockish(child),
  );
}

function tagOf(element) {
  return (element.rawTagName ?? '').toLowerCase();
}

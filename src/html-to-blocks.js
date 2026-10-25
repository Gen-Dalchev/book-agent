// XHTML главы → плоский список блоков: заголовки (с уровнем из h1–h6) и текстовые
// блоки в markdown (абзацы, списки, цитаты). Простой обход дерева: курсив и жирный
// сохраняются, картинки, стили и скрипты отбрасываются, остальное — текстом.
// Сноски (footnotes.js) заменяются метками, а примечания в блоки не попадают:
// их тексты отдаются отдельно. Сноски в другой файл видны, только когда документы
// книги разбираются разом (documentsToBlocks).
import { parse } from 'node-html-parser';
import { extractBookFootnotes, extractFootnotes } from './footnotes.js';
import { ELEMENT, TEXT, HEADING_LEVELS, SKIP, BLOCK, tagOf } from './html-tags.js';

const ITALIC = new Set(['em', 'i', 'cite', 'dfn', 'var']);
const BOLD = new Set(['strong', 'b']);
const CODE = new Set(['code', 'kbd', 'samp', 'tt']);

// Пробелы HTML схлопываются, а неразрывный пробел (U+00A0) и прочие — нет:
// текст должен совпасть с исходным посимвольно.
const HTML_SPACE = /[ \t\n\r\f]+/g;
const EDGE_SPACE = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g;

// Узлы, которые нужно пропустить при выводе (обратные ссылки внутри примечания):
// вне примечаний — никаких.
const NOTHING = new Set();

/**
 * @param {string} html
 * @param {{href?: string}} [options] href — путь документа в архиве: по нему ссылки
 *   «файл.xhtml#id» на этот же документ тоже считаются сносками
 * @returns {{title: string, blocks: ({type: 'heading', level: number, text: string} | {type: 'text', text: string})[],
 *   notes: string[]}}
 *   notes — тексты сносок; в тексте блоков сноска — служебная метка (footnotes.js)
 */
export function htmlToBlocks(html, { href = null } = {}) {
  const { title, body } = parseDocument(html);
  const { notes } = extractFootnotes(body, { href, render: renderHiding });
  return { title, blocks: bodyBlocks(body), notes };
}

/**
 * Все документы книги разом: сноски ищутся и в другом документе (footnotes.js).
 * @param {{html: string, href: string}[]} documents в порядке чтения
 * @param {{closed?: Set<string>}} [options] closed — служебные документы: ссылка в них — не сноска
 * @returns {{title: string, blocks: import('./chapters.js').Block[], notes: string[], notesFile: boolean}[]}
 *   notesFile — из документа вырезано примечание по сноске из другого документа
 */
export function documentsToBlocks(documents, { closed = new Set() } = {}) {
  const parsed = documents.map(({ html, href }) => ({ href, ...parseDocument(html) }));
  const found = extractBookFootnotes(parsed, { closed, render: renderHiding });
  return parsed.map(({ title, body }, index) => ({ title, blocks: bodyBlocks(body), ...found[index] }));
}

/** Блоки документа как есть, без разбора сносок: ссылки остаются текстом, примечания — на месте. */
export function blocksWithoutFootnotes(html) {
  return bodyBlocks(parseDocument(html).body);
}

function parseDocument(html) {
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: { script: true, style: true },
  });
  const title = cleanInline(root.querySelector('title')?.text ?? '').replace(/\n/g, ' ');
  return { title, body: root.querySelector('body') ?? root };
}

function bodyBlocks(body) {
  const blocks = [];
  collectBlocks(body, blocks);
  return blocks;
}

function renderHiding(element, hidden) {
  return renderChildren(element, {}, hidden);
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

function renderInline(node, style = {}, hidden = NOTHING) {
  if (node.nodeType === TEXT) return collapse(node.text);
  if (node.nodeType !== ELEMENT) return '';
  const tag = tagOf(node);
  if (SKIP.has(tag) || hidden.has(node)) return '';
  if (tag === 'br') return '\n';
  if (ITALIC.has(tag) && !style.italic) {
    return wrap(renderChildren(node, { ...style, italic: true }, hidden), '*');
  }
  if (BOLD.has(tag) && !style.bold) {
    return wrap(renderChildren(node, { ...style, bold: true }, hidden), '**');
  }
  if (CODE.has(tag) && !style.code) {
    return wrap(renderChildren(node, { ...style, code: true }, hidden), '`');
  }
  // Блочный элемент внутри строки (абзац в заголовке, в ячейке) — через пробел.
  if (BLOCK.has(tag)) return ` ${renderChildren(node, style, hidden)} `;
  return renderChildren(node, style, hidden);
}

function renderChildren(element, style = {}, hidden = NOTHING) {
  return element.childNodes.map((child) => renderInline(child, style, hidden)).join('');
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
// считается и строка из одних пробелов, в том числе неразрывных.
function cleanInline(text) {
  return text
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

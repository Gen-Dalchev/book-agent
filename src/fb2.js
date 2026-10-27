// Чтение FB2 (XML FictionBook 2): байты → текст по кодировке из пролога → дерево XML →
// данные издания из description и тела книги (body) секциями с текстом в markdown.
// Главы из секций собирает fb2-chapters.js. Картинки, аннотация и оформление не читаются.
//
// Сноски (Б-15): ссылка из основного body на секцию body примечаний становится меткой
// (footnotes.js) ещё в дереве, до превращения в блоки; секция-примечание помечена номером
// метки, а уходит ли она из примечаний, решает fb2-chapters.js.
import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { readIsbns, readYear } from './epub.js';
import { markFor, plain } from './footnotes.js';
import { ImportError } from './errors.js';

/** Имена body с примечаниями; основной body — первый без такого имени. */
export const NOTES_BODIES = new Set(['notes', 'comments']);

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const PROLOG = /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([^"']+)["']/;
const CONTAINER = 'META-INF/container.xml';
const FB2_FILE = /\.fb2$/i;

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  // Пробелы вокруг курсива и между словами — часть текста.
  trimValues: false,
  // Без этого не раскрываются &#160; и &#x2014;.
  htmlEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

// Пробелы XML схлопываются, неразрывный (U+00A0) — нет, как у EPUB.
const XML_SPACE = /[ \t\n\r]+/g;
const EDGE_SPACE = /^ +| +$/g;
const HAS_TEXT = /[\p{L}\p{N}]/u;
// Остальные строчные (strikethrough, sub, sup, style, a) — только текст; ссылка-сноска
// к этому времени уже заменена меткой (linkNotes).
const MARKERS = { emphasis: '*', strong: '**', code: '`' };
// Не импортируются (Б-14): картинки, аннотация — и у книги, и у раздела.
const NOTHING = new Set(['image', 'empty-line', 'binary', 'annotation']);
const TITLE_END = /[.!?…:;]$/;

/**
 * Элемент дерева: имя без пространства имён, атрибуты, дети по порядку файла; текст — {text}.
 * @typedef {{name: string, attrs: Record<string, string>, children: Node[]} | {text: string}} Node
 */

/**
 * Содержимое секции или тела книги по порядку: блок текста в markdown (абзац, цитата,
 * строфа, таблица — один абзац; heading — подзаголовок, в части — «### …») или вложенная секция.
 * @typedef {{type: 'text' | 'heading', text: string} | Section} Item
 * @typedef {{type: 'section', title: string | null, items: Item[], noteId?: number}} Section
 *   noteId — секция-примечание, на которую ведёт сноска: номер её метки
 * @typedef {{name: string | null, title: string | null, items: Item[]}} Body
 */

/**
 * @param {Uint8Array} data содержимое файла .fb2
 * @returns {{metadata: import('./epub.js').Metadata, bodies: Body[], notes: string[]}}
 *   bodies — по порядку файла; notes — тексты сносок, номер метки — индекс
 */
export function readFb2(data) {
  const xml = decode(data);
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    const { msg, line } = valid.err;
    throw new ImportError(`FB2 не разобрался: ${msg} (строка ${line}).`);
  }
  const root = toNodes(xmlParser.parse(xml)).find((node) => node.name === 'FictionBook');
  if (!root) throw new ImportError('FB2 не разобрался: в файле нет элемента FictionBook.');

  const description = child(root, 'description');
  const bodyNodes = children(root, 'body');
  const { notes, noteIds } = linkNotes(bodyNodes);
  const bodies = bodyNodes.map((body) => {
    const title = child(body, 'title');
    return {
      name: body.attrs.name ?? null,
      title: title ? titleText(title) : null,
      items: contentItems(body.children.filter((node) => node !== title), noteIds),
    };
  });
  return { metadata: readMetadata(description), bodies, notes };
}

/**
 * Ссылка из основного body (`<a l:href="#id">`, префикс и type — любые) на секцию любой глубины
 * в body примечаний → метка вместо ссылки, прямо в дереве. Ссылки в других body, на id, которого
 * в примечаниях нет, и наружу остаются текстом; примечание без текста — не сноска.
 * @param {Node[]} bodies все body по порядку файла
 * @returns {{notes: string[], noteIds: Map<Node, number>}} notes — тексты сносок, номер метки — индекс;
 *   noteIds — секция-примечание → номер её метки
 */
function linkNotes(bodies) {
  const targets = new Map();
  for (const body of bodies.filter((node) => NOTES_BODIES.has(node.attrs.name))) {
    for (const element of elements(body)) {
      const { id } = element.attrs;
      if (element.name === 'section' && id && !targets.has(id)) targets.set(id, element);
    }
  }
  const notes = [];
  const noteIds = new Map();
  const visit = (node, skip = null) => {
    node.children.forEach((item, index) => {
      if (item === skip || 'text' in item || NOTHING.has(item.name)) return;
      const href = item.name === 'a' ? item.attrs.href ?? '' : '';
      const section = href.startsWith('#') ? targets.get(href.slice(1)) : undefined;
      if (section && !noteIds.has(section)) {
        const text = noteText(section);
        if (text) {
          noteIds.set(section, notes.length);
          notes.push(text);
        }
      }
      if (noteIds.has(section)) node.children[index] = { text: markFor(noteIds.get(section)) };
      else visit(item);
    });
  };
  const main = bodies.find((node) => !NOTES_BODIES.has(node.attrs.name));
  // Название книги в части не идёт — ссылка в нём сноской не становится.
  if (main) visit(main, child(main, 'title'));
  return { notes, noteIds };
}

// Все элементы внутри узла, по порядку файла.
function elements(node) {
  return node.children.flatMap((item) => ('text' in item ? [] : [item, ...elements(item)]));
}

// Текст примечания одной строкой: секция без своего title (номера); абзацы, строки стихов
// и вложенные секции — через пробел, курсив и жирный — как в абзацах.
function noteText(section) {
  const title = child(section, 'title');
  const lines = (items) => items.flatMap((item) => (item.type === 'section'
    ? [...(item.title ? [item.title] : []), ...lines(item.items)] : [item.text]));
  return lines(contentItems(section.children.filter((node) => node !== title)))
    .join(' ')
    .replace(/ *\n */g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * FB2 в zip (.fb2.zip): в архиве нет META-INF/container.xml и ровно один файл *.fb2.
 * @param {Uint8Array} data содержимое zip
 * @returns {Promise<Uint8Array | null>} null — это не FB2 в zip: разбирать как EPUB
 */
export async function fb2FromZip(data) {
  let zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    return null; // битый архив — ошибку даст разбор EPUB
  }
  if (zip.file(CONTAINER)) return null;
  const books = Object.values(zip.files).filter((file) => !file.dir && FB2_FILE.test(file.name));
  if (books.length > 1) throw new ImportError('в архиве несколько книг FB2 — распакуйте нужную.');
  if (books.length === 0) return null;
  try {
    return await books[0].async('uint8array');
  } catch (cause) {
    throw new ImportError(`архив повреждён: не удалось распаковать ${books[0].name}.`, { cause });
  }
}

// Кодировка — из пролога, нет — UTF-8; BOM UTF-8 важнее пролога и снимается.
function decode(data) {
  const bom = UTF8_BOM.every((byte, index) => data[index] === byte);
  const head = new TextDecoder('latin1').decode(data.subarray(0, 1024));
  const label = bom ? 'utf-8' : head.match(PROLOG)?.[1] ?? 'utf-8';
  let decoder;
  try {
    decoder = new TextDecoder(label);
  } catch (error) {
    if (error instanceof RangeError) throw new ImportError(`неизвестная кодировка FB2: ${label}.`);
    throw error;
  }
  return decoder.decode(data);
}

// Вывод парсера с preserveOrder ([{тег: [дети], ':@': атрибуты} | {'#text': …}]) → Node[].
function toNodes(list) {
  return list.flatMap((entry) => {
    if ('#text' in entry) return [{ text: String(entry['#text']) }];
    const name = Object.keys(entry).find((key) => key !== ':@');
    if (name === undefined) return [];
    return [{ name, attrs: entry[':@'] ?? {}, children: toNodes(entry[name]) }];
  });
}

function children(node, name) {
  return (node?.children ?? []).filter((item) => item.name === name);
}

function child(node, name) {
  return children(node, name)[0] ?? null;
}

// Весь текст элемента одной строкой, без разметки.
function textOf(node) {
  if (!node) return '';
  const raw = (item) => ('text' in item ? item.text : item.children.map(raw).join(''));
  return raw(node).replace(XML_SPACE, ' ').trim();
}

function readMetadata(description) {
  const titleInfo = child(description, 'title-info');
  const publishInfo = child(description, 'publish-info');
  const texts = (node, name) => children(node, name).map(textOf).filter(Boolean);
  return {
    title: texts(titleInfo, 'book-title')[0] ?? '',
    authors: children(titleInfo, 'author').map(personName).filter(Boolean),
    language: texts(titleInfo, 'lang')[0] ?? '',
    translators: children(titleInfo, 'translator').map(personName).filter(Boolean),
    publishers: texts(publishInfo, 'publisher'),
    year: readYear(texts(publishInfo, 'year')),
    isbns: readIsbns(texts(publishInfo, 'isbn')),
  };
}

// «Имя Отчество Фамилия» — что есть; нет ни одного — псевдоним.
function personName(person) {
  const name = ['first-name', 'middle-name', 'last-name']
    .map((part) => textOf(child(person, part)))
    .filter(Boolean)
    .join(' ');
  return name || textOf(child(person, 'nickname'));
}

// Заголовок из нескольких абзацев — одной строкой: через «. » или, после знака препинания, через пробел.
function titleText(title) {
  const lines = children(title, 'p').map(inline).filter((line) => HAS_TEXT.test(line));
  if (lines.length === 0) {
    const text = inline(title);
    return HAS_TEXT.test(text) ? text : null;
  }
  return lines.reduce((joined, line) => {
    const bare = plain(joined).replace(/[*`]+$/, '');
    return `${joined}${TITLE_END.test(bare) ? ' ' : '. '}${line}`;
  });
}

/**
 * Дети секции или тела книги → Item[]: секции — вложенными, остальное — блоками.
 * @param {Node[]} nodes
 * @param {Map<Node, number>} [noteIds] секция-примечание → номер её метки (linkNotes)
 */
function contentItems(nodes, noteIds = new Map()) {
  const items = [];
  for (const node of nodes) {
    if ('text' in node) {
      // Текст прямо в секции, без абзаца, — абзацем.
      const text = clean(node.text);
      if (text) items.push({ type: 'text', text });
    } else if (node.name === 'section') {
      const title = child(node, 'title');
      const noteId = noteIds.get(node);
      items.push({
        type: 'section',
        title: title ? titleText(title) : null,
        items: contentItems(node.children.filter((item) => item !== title), noteIds),
        ...(noteId === undefined ? {} : { noteId }),
      });
    } else {
      items.push(...blocks(node));
    }
  }
  return items;
}

/** Блочный элемент → блоки. */
function blocks(node) {
  const text = (value) => (/\S/.test(value) ? [{ type: 'text', text: value }] : []);
  switch (node.name) {
    case 'p':
    case 'text-author':
    case 'date':
    case 'v':
      return text(inline(node));
    case 'subtitle': {
      const value = inline(node);
      return /\S/.test(value) ? [{ type: 'heading', text: value }] : [];
    }
    case 'title': {
      // Заголовок не на своём месте (у стиха, у строфы, второй у секции) — «###».
      const value = titleText(node);
      return value ? [{ type: 'heading', text: value }] : [];
    }
    case 'epigraph':
    case 'cite':
      return text(quote(node));
    case 'poem':
      return node.children.flatMap((item) => ('text' in item ? [] : blocks(item)));
    case 'stanza':
      return stanza(node);
    case 'table':
      return text(table(node));
    default:
      if (NOTHING.has(node.name)) return [];
      return contentItems(node.children).filter((item) => item.type !== 'section');
  }
}

// Строфа — один абзац, строки через перенос; её заголовок — «###» перед ней.
function stanza(node) {
  const heads = node.children.filter((item) => item.name === 'title' || item.name === 'subtitle');
  const lines = children(node, 'v').map(inline).filter((line) => /\S/.test(line));
  const out = heads.flatMap(blocks);
  if (lines.length) out.push({ type: 'text', text: lines.join('\n') });
  return out;
}

// Эпиграф и цитата — как blockquote у EPUB: строки с «> », блоки через «>», один абзац.
function quote(node) {
  const inner = node.children.flatMap((item) => {
    if ('text' in item) {
      const text = clean(item.text);
      return text ? [text] : [];
    }
    if (item.name === 'section') return [];
    return blocks(item).map((block) => block.text);
  });
  return inner.map((block) => block.split('\n').map((line) => `> ${line}`).join('\n')).join('\n>\n');
}

// Таблица — один абзац: строки через перенос, ячейки через « | ».
function table(node) {
  return children(node, 'tr')
    .map((row) => row.children.filter((cell) => cell.name === 'th' || cell.name === 'td').map(inline).join(' | '))
    .filter((line) => line.replace(/[ |]/g, ''))
    .join('\n');
}

// Строчное содержимое → markdown одной строкой: курсив, жирный, код; остальное — текстом.
function inline(node) {
  return clean(renderInline(node, {}));
}

function renderInline(node, style) {
  if ('text' in node) return node.text.replace(XML_SPACE, ' ');
  if (NOTHING.has(node.name)) return '';
  const marker = MARKERS[node.name];
  const inner = marker && !style[node.name] ? { ...style, [node.name]: true } : style;
  const content = node.children.map((item) => renderInline(item, inner)).join('');
  if (inner !== style) return wrap(content, marker);
  // Абзац внутри строки (абзацы заголовка, ячейка с абзацами) — через пробел.
  return node.name === 'p' ? ` ${content} ` : content;
}

// Пробелы по краям выносятся за маркеры: «* слово *» markdown не поймёт.
function wrap(inner, marker) {
  const [, lead, core, trail] = inner.match(/^( *)([\s\S]*?)( *)$/);
  if (!core) return inner;
  return `${lead}${marker}${core}${marker}${trail}`;
}

function clean(text) {
  return text.replace(XML_SPACE, ' ').replace(EDGE_SPACE, '');
}

// Служебные страницы издания — обложка, титул, выходные данные, оглавление самой
// книги: они не становятся главами, а попадают в «Пропущено» в book.md.
// Сначала разметка файла, а когда её нет — признаки. Сомнение — оставить:
// лучше лишняя часть, чем потерянный текст. Слова-признаки (©, ISBN…) — только
// здесь; главы по-прежнему определяются по структуре файла.
import path from 'node:path';
import { parse } from 'node-html-parser';
import { epubTypes, resolveHref } from './epub.js';
import { plain } from './footnotes.js';
import { countWords } from './words.js';

// Пороги приняты по умолчанию — поправить по первой настоящей книге.
export const LIMITS = {
  copyrightMaxWords: 300, // выходные данные — документ меньше стольких слов…
  copyrightMinSigns: 2, // …где есть хотя бы столько признаков
  tocMinShare: 0.5, // оглавление — ссылок больше такой доли текстовых элементов
  titleMaxWords: 40, // титул — документ меньше стольких слов…
  titleMaxBlockWords: 20, // …и ни одного абзаца длиннее
};

export const REASONS = {
  copyright: 'признаки: выходные данные',
  toc: 'признаки: оглавление',
  title: 'признаки: титул',
};

// epub:type у body или верхнего section и типы в landmarks (EPUB 3).
const MARKUP_TYPES = new Set(['cover', 'titlepage', 'copyright-page', 'toc', 'colophon']);
// Типы <reference> в <guide> (EPUB 2).
const GUIDE_TYPES = new Set(['cover', 'title-page', 'copyright-page', 'toc']);

const COPYRIGHT_SIGNS = [
  /©/u,
  /(?<!\p{L})ISBN(?!\p{L})/iu,
  /(?<!\p{L})УДК(?!\p{L})/iu,
  /(?<!\p{L})ББК(?!\p{L})/iu,
  /все\s+права\s+защищены/iu,
  /all\s+rights\s+reserved/iu,
];

const HAS_TEXT = /[\p{L}\p{N}]/u;
const ELEMENT = 1;
const TEXT = 3;
const NOT_CONTENT = new Set(['script', 'style', 'noscript', 'template']);
const TEXT_ELEMENTS = 'p, li, div';
const NESTED_BLOCKS = [
  'p', 'div', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'section', 'article', 'nav', 'aside', 'header', 'footer', 'main', 'blockquote',
  'table', 'figure', 'pre', 'address',
].join(', ');
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * @param {{metadata: import('./epub.js').Metadata,
 *   documents: {href: string, html: string, linear: boolean, blocks: import('./chapters.js').Block[]}[],
 *   landmarks: import('./epub.js').Landmark[], guide: import('./epub.js').Landmark[]}} book
 * @returns {(string | null)[]} по документу: причина пропуска или null — оставить
 */
export function frontMatterReasons({ metadata, documents, landmarks, guide }) {
  // Ссылка с фрагментом (file.html#toc) ведёт в часть документа — не повод пропускать его целиком.
  const marked = new Map();
  const marks = [
    ...landmarks.filter((mark) => MARKUP_TYPES.has(mark.type)),
    ...guide.filter((mark) => GUIDE_TYPES.has(mark.type)),
  ];
  for (const mark of marks) {
    if (!mark.fragment && !marked.has(mark.href)) marked.set(mark.href, mark.type);
  }
  const bookFiles = new Set(documents.map((doc) => doc.href));

  return documents.map((doc) => {
    // linear="no" — обычно примечания; пустые документы отбрасываются и без этого.
    if (!doc.linear || !doc.blocks.some((block) => HAS_TEXT.test(block.text))) return null;
    const root = parse(doc.html, { lowerCaseTagName: true, comment: false, blockTextElements: { script: true, style: true } });
    const body = root.querySelector('body') ?? root;

    const type = ownMarkup(body) ?? marked.get(doc.href);
    if (type) return `разметка: ${type}`;

    const text = plain(doc.blocks.map((block) => block.text).join('\n')).replace(/[*`]/g, '');
    const words = countWords(text);
    if (isCopyright(text, words)) return REASONS.copyright;
    if (isTableOfContents(body, doc.href, bookFiles)) return REASONS.toc;
    if (isTitlePage(doc.blocks, text, words, metadata.title)) return REASONS.title;
    return null;
  });
}

// Служебным размечен весь документ: epub:type у body или у единственного верхнего section.
function ownMarkup(body) {
  const types = epubTypes(body);
  const children = body.childNodes.filter((node) =>
    (node.nodeType === ELEMENT && !NOT_CONTENT.has(tagOf(node))) || (node.nodeType === TEXT && HAS_TEXT.test(node.text)));
  if (children.length === 1 && tagOf(children[0]) === 'section') types.push(...epubTypes(children[0]));
  return types.find((type) => MARKUP_TYPES.has(type)) ?? null;
}

function isCopyright(text, words) {
  if (words >= LIMITS.copyrightMaxWords) return false;
  return COPYRIGHT_SIGNS.filter((sign) => sign.test(text)).length >= LIMITS.copyrightMinSigns;
}

// Больше половины текстовых элементов (p, li, div без вложенных блоков) — целиком
// ссылка на другой документ книги. В примечании с обратной ссылкой есть и свой текст.
function isTableOfContents(body, href, bookFiles) {
  const dir = path.posix.dirname(href);
  const isBookLink = (element) => {
    const target = element.getAttribute('href');
    if (!target || target.startsWith('#') || URL_SCHEME.test(target)) return false;
    const file = resolveHref(dir, target);
    return file !== href && bookFiles.has(file);
  };
  const isWholeLink = (element) => {
    const wrapper = element.closest('a');
    if (wrapper && isBookLink(wrapper)) return true;
    let linked = false;
    let outside = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === TEXT) {
          outside += child.text;
        } else if (child.nodeType === ELEMENT && !NOT_CONTENT.has(tagOf(child))) {
          if (tagOf(child) === 'a' && isBookLink(child)) linked = true;
          else walk(child);
        }
      }
    };
    walk(element);
    return linked && !HAS_TEXT.test(outside);
  };

  let total = 0;
  let links = 0;
  for (const element of body.querySelectorAll(TEXT_ELEMENTS)) {
    if (element.querySelector(NESTED_BLOCKS) || !HAS_TEXT.test(element.text)) continue;
    total += 1;
    if (isWholeLink(element)) links += 1;
  }
  return total > 0 && links > total * LIMITS.tocMinShare;
}

// Короткий документ с названием книги из метаданных и без длинных абзацев.
function isTitlePage(blocks, text, words, title) {
  const name = normalize(title);
  if (!name || words >= LIMITS.titleMaxWords) return false;
  if (blocks.some((block) => countWords(block.text) > LIMITS.titleMaxBlockWords)) return false;
  return ` ${normalize(text)} `.includes(` ${name} `);
}

// Без учёта регистра и знаков препинания.
function normalize(text = '') {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tagOf(node) {
  return (node.rawTagName ?? '').toLowerCase();
}

// Документы (списки блоков) → главы и части для чтения. Не зависит от формата:
// EPUB даёт по документу на элемент spine, другие форматы дадут свои документы.
//
// Глава — непустой документ. Её заголовок — заголовок в самом начале документа.
// Подглава — подзаголовок самого верхнего уровня из тех, что повторяются в главе
// (обычно h2 или h3). Повторяющихся нет — глава остаётся одной частью.
//
// Сноски: в тексте блоков — метки (footnotes.js), в части они получают номера [^N]
// по порядку появления, а определения идут одним блоком в конце файла части.
import { countWords } from './words.js';
import { numberMarks, plain, shiftMarks } from './footnotes.js';

const HAS_TEXT = /[\p{L}\p{N}]/u;
const FALLBACK_TITLE_WORDS = 8;

/**
 * @typedef {{type: 'heading', level: number, text: string} | {type: 'text', text: string}} Block
 * @typedef {{kind: 'whole' | 'intro' | 'section', title: string, markdown: string, words: number,
 *   footnotes?: number}} Part footnotes — число определений сносок в конце файла (нет — 0)
 * @typedef {{title: string, parts: Part[]}} Chapter
 */

/**
 * @param {{blocks: Block[], notes?: string[]}[]} documents в порядке чтения
 * @returns {Chapter[]} пустые документы (обложка, одна картинка) пропущены
 */
export function buildChapters(documents) {
  return documents.map(splitDocument).filter(Boolean);
}

/** @returns {Chapter | null} */
export function splitDocument({ blocks, notes = [] }) {
  if (!blocks.some((block) => HAS_TEXT.test(block.text))) return null;

  const titleBlock = blocks[0].type === 'heading' ? blocks[0] : null;
  const rest = titleBlock ? blocks.slice(1) : blocks;
  const title = plain(titleBlock?.text ?? fallbackTitle(blocks));

  const sectionLevel = repeatedTopLevel(rest);
  const subLevel = sectionLevel ?? Math.min(...headingLevels(rest));
  const toMarkdown = (block) => {
    if (block.type !== 'heading') return block.text;
    const marks = block === titleBlock ? '#' : block.level <= subLevel ? '##' : '###';
    return `${marks} ${block.text}`;
  };
  const makePart = (kind, partTitle, partBlocks) => renderPart(kind, partTitle, partBlocks.map(toMarkdown), notes);

  if (sectionLevel === null) {
    return { title, parts: [makePart('whole', title, blocks)] };
  }

  const isSectionStart = (block) => block.type === 'heading' && block.level === sectionLevel;
  const firstSection = rest.findIndex(isSectionStart);
  const intro = rest.slice(0, firstSection);
  const head = titleBlock ? [titleBlock] : [];

  const parts = [];
  const introHasText = intro.some((block) => HAS_TEXT.test(block.text));
  if (introHasText) parts.push(makePart('intro', title, [...head, ...intro]));

  let start = firstSection;
  while (start < rest.length) {
    let end = start + 1;
    while (end < rest.length && !isSectionStart(rest[end])) end += 1;
    // Заголовок главы — в начале первой части главы, где бы она ни начиналась.
    const lead = parts.length === 0 ? head : [];
    parts.push(makePart('section', rest[start].text, [...lead, ...rest.slice(start, end)]));
    start = end;
  }
  return { title, parts };
}

/**
 * Глава из нескольких документов: часть — свой документ и, если есть, его продолжения
 * (документы без своего заголовка в структуре книги). EPUB так собирает часть книги
 * из оглавления, где её главы — отдельные файлы.
 * В части-разделе её заголовок — «##»: первый блок первого документа, если он заголовок,
 * иначе title; остальные заголовки — «###», частей они не делят. В начале (intro) заголовков
 * «##» нет. Заголовок главы «#» — в начале первой части.
 * @param {string} title название главы
 * @param {{kind: 'intro' | 'section', title: string, fixed?: boolean,
 *   documents: {blocks: Block[], notes?: string[]}[]}[]} sections в порядке чтения;
 *   fixed — в оглавлении title, даже если у части есть свой заголовок
 * @returns {Chapter}
 */
export function joinChapter(title, sections) {
  const parts = sections.map((section, index) => {
    const lines = index === 0 ? [`# ${title}`] : [];
    const notes = [];
    let partTitle = section.title;
    section.documents.forEach((doc, docIndex) => {
      const offset = notes.length;
      notes.push(...(doc.notes ?? []));
      doc.blocks.forEach((block, blockIndex) => {
        const text = shiftMarks(block.text, offset);
        const opens = section.kind === 'section' && docIndex === 0 && blockIndex === 0;
        if (opens && block.type === 'heading') {
          lines.push(`## ${text}`);
          if (!section.fixed) partTitle = block.text;
        } else {
          if (opens) lines.push(`## ${section.title}`);
          lines.push(block.type === 'heading' ? `### ${text}` : text);
        }
      });
    });
    return renderPart(section.kind, partTitle, lines, notes);
  });
  return { title, parts };
}

// Тексты блоков части в markdown → файл части: блоки через пустую строку, сноски — в конце.
function renderPart(kind, title, texts, notes) {
  const { texts: numbered, definitions } = numberMarks(texts, notes);
  const body = numbered.join('\n\n');
  const markdown = definitions.length > 0 ? `${body}\n\n${definitions.join('\n')}\n` : `${body}\n`;
  return { kind, title: plain(title), markdown, words: countWords(markdown), footnotes: definitions.length };
}

function headingLevels(blocks) {
  return blocks.filter((block) => block.type === 'heading').map((block) => block.level);
}

function repeatedTopLevel(blocks) {
  const counts = new Map();
  for (const level of headingLevels(blocks)) counts.set(level, (counts.get(level) ?? 0) + 1);
  const repeated = [...counts].filter(([, count]) => count >= 2).map(([level]) => level);
  return repeated.length ? Math.min(...repeated) : null;
}

// Документ без заголовка в начале: подписываем главу её первыми словами.
// Так же подписан пропущенный документ в «Пропущено».
export function fallbackTitle(blocks) {
  const first = blocks.find((block) => HAS_TEXT.test(block.text));
  const words = plain(first.text).replace(/[*`#>]/g, '').split(/\s+/u).filter(Boolean);
  const head = words.slice(0, FALLBACK_TITLE_WORDS).join(' ');
  return words.length > FALLBACK_TITLE_WORDS ? `${head}…` : head;
}

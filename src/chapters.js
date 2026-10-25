// Документы (списки блоков) → главы и части для чтения. Не зависит от формата:
// EPUB даёт по документу на элемент spine, другие форматы дадут свои документы.
//
// Глава — непустой документ. Её заголовок — заголовок в самом начале документа.
// Подглава — подзаголовок самого верхнего уровня из тех, что повторяются в главе
// (обычно h2 или h3). Повторяющихся нет — глава остаётся одной частью.
//
// Сноски (Б-07) нумеруются в каждой части заново, определения — в конце её файла;
// в заголовках для оглавления меток нет.
import { countWords } from './words.js';
import { placeNotes, stripNoteMarks } from './footnotes.js';

const HAS_TEXT = /[\p{L}\p{N}]/u;
const FALLBACK_TITLE_WORDS = 8;

/**
 * @typedef {{type: 'heading', level: number, text: string} | {type: 'text', text: string}} Block
 * @typedef {{kind: 'whole' | 'intro' | 'section', title: string, markdown: string, words: number}} Part
 * @typedef {{title: string, parts: Part[]}} Chapter
 */

/**
 * @param {{blocks: Block[], notes?: string[]}[]} documents в порядке чтения;
 *   notes — тексты сносок по номеру метки в блоках (html-to-blocks.js)
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
  const title = titleBlock ? stripNoteMarks(titleBlock.text) : fallbackTitle(blocks);

  const sectionLevel = repeatedTopLevel(rest);
  const subLevel = sectionLevel ?? Math.min(...headingLevels(rest));
  const toMarkdown = (block) => {
    if (block.type !== 'heading') return block.text;
    const marks = block === titleBlock ? '#' : block.level <= subLevel ? '##' : '###';
    return `${marks} ${block.text}`;
  };
  const makePart = (kind, partTitle, partBlocks) => {
    const text = `${partBlocks.map(toMarkdown).join('\n\n')}\n`;
    const { markdown, notes: used } = placeNotes(text, notes);
    return { kind, title: partTitle, markdown, words: countWords(text) + countWords(used.join('\n')) };
  };

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
    parts.push(makePart('section', stripNoteMarks(rest[start].text), [...lead, ...rest.slice(start, end)]));
    start = end;
  }
  return { title, parts };
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
  const words = stripNoteMarks(first.text).replace(/[*`#>]/g, '').split(/\s+/u).filter(Boolean);
  const head = words.slice(0, FALLBACK_TITLE_WORDS).join(' ');
  return words.length > FALLBACK_TITLE_WORDS ? `${head}…` : head;
}

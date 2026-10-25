// Ссылки на место в книге: «003-02 ¶12», «003 ¶1–40» (Б-04). Номер абзаца считается
// по файлу части, а не по внутренностям импорта: файл делится на блоки по пустой
// строке; блок кода в ``` — один блок; заголовки и разделители не считаются;
// блок определений сносок в конце файла (каждая строка — «[^N]: ») тоже не считается (Б-07);
// остальные блоки — абзацы, по порядку с 1. Этот счёт — мерило нумерации.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { partId, PARTS_DIR } from './layout.js';
import { RefError } from './errors.js';

export const REF_FORMAT = 'ссылка — часть и, если нужно, абзацы: «003-02», «003-02 ¶12», «003-02 ¶3–5»; часть — NNN или NNN-MM';

const PART_NAME = /^(\d{3})(?:-(\d{2}))?$/;
const RANGE = /^(\d+)(?:\s*[-–—]\s*(\d+))?$/;
const BLANK = /^\s*$/;
const FENCE = /^```/;
const HEADING = /^#{1,6} /;
const SEPARATOR = /^(?:---|\*\*\*|\* \* \*)$/;
const DEFINITION = /^\[\^\d+\]: /;

/**
 * @typedef {{kind: 'paragraph' | 'heading' | 'separator' | 'definitions', text: string, number?: number}} Block
 * @typedef {{part: string, from: number | null, to: number | null}} Ref
 *   from и to — null, когда нужна вся часть
 */

/**
 * Текст части → блоки по порядку; у абзацев — номер.
 * @param {string} markdown
 * @returns {Block[]}
 */
export function splitBlocks(markdown) {
  const blocks = [];
  let lines = [];
  let inFence = false;
  const flush = () => {
    if (lines.length) blocks.push(classify(lines.join('\n')));
    lines = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (!inFence && BLANK.test(line)) {
      flush();
      continue;
    }
    if (FENCE.test(line)) inFence = !inFence;
    lines.push(line);
  }
  flush();
  const last = blocks.at(-1);
  if (last?.kind === 'paragraph' && last.text.split('\n').every((line) => DEFINITION.test(line))) {
    last.kind = 'definitions';
  }
  let number = 0;
  for (const block of blocks) {
    if (block.kind === 'paragraph') block.number = ++number;
  }
  return blocks;
}

function classify(text) {
  if (HEADING.test(text)) return { kind: 'heading', text };
  if (SEPARATOR.test(text.trim())) return { kind: 'separator', text };
  return { kind: 'paragraph', text };
}

/**
 * «003-02 ¶12», «003-02¶3–5», «003» → ссылка. Проверяет только вид, файлов не трогает.
 * @param {string} text
 * @returns {Ref}
 */
export function parseRef(text) {
  const [rawPart, rawRange, ...rest] = text.trim().split('¶');
  const part = rawPart.trim();
  if (rest.length > 0) throw new RefError(`«${text}» — не ссылка: знак ¶ больше одного раза. Формат: ${REF_FORMAT}.`);
  if (/\s/.test(part)) {
    throw new RefError(`«${text}» — не ссылка: перед номером абзаца нужен знак ¶. Формат: ${REF_FORMAT}.`);
  }
  if (!PART_NAME.test(part)) throw new RefError(`«${part}» — не имя части. Формат: ${REF_FORMAT}.`);
  if (rawRange === undefined) return { part, from: null, to: null };

  const match = rawRange.trim().match(RANGE);
  if (!match) throw new RefError(`«¶${rawRange.trim()}» — не номер абзаца. Формат: ${REF_FORMAT}.`);
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 1) throw new RefError('Абзацы считаются с 1, а ¶0 не бывает.');
  return { part, from, to };
}

/**
 * Текст части с номерами абзацев: вся часть, один абзац или диапазон
 * (тогда — с заголовками и разделителями между абзацами диапазона).
 * @param {string} bookDir папка книги после импорта
 * @param {Ref} ref
 * @returns {Promise<string>}
 */
export async function showRef(bookDir, ref) {
  const markdown = await readPart(bookDir, ref.part);
  const blocks = selectBlocks(splitBlocks(markdown), ref);
  return `${blocks.map(formatBlock).join('\n\n')}\n`;
}

function selectBlocks(blocks, { part, from, to }) {
  if (from === null) return blocks;
  const count = blocks.filter((block) => block.kind === 'paragraph').length;
  const asked = from === to ? `¶${from}` : `¶${from}–${to}`;
  if (to < from) {
    throw new RefError(`Диапазон ${asked} задом наперёд: первый номер больше второго. В части ${part} абзацев: ${count}.`);
  }
  if (to > count) throw new RefError(`В части ${part} абзацев: ${count}, а запрошен ${asked}.`);
  const start = blocks.findIndex((block) => block.number === from);
  const end = blocks.findIndex((block) => block.number === to);
  return blocks.slice(start, end + 1);
}

function formatBlock(block) {
  return block.kind === 'paragraph' ? `¶${block.number} ${block.text}` : block.text;
}

async function readPart(bookDir, part) {
  const partsDir = path.join(bookDir, PARTS_DIR);
  await ensureDir(bookDir, `Папки книги нет: ${bookDir}`);
  await ensureDir(partsDir, `В папке ${bookDir} нет ${PARTS_DIR}/ — это не папка книги после импорта.`);
  const [, chapter, sub] = part.match(PART_NAME);
  const name = partId(Number(chapter), sub === undefined ? null : Number(sub));
  try {
    return await readFile(path.join(partsDir, `${name}.md`), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const ids = (await readdir(partsDir))
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -'.md'.length))
    .sort();
  const pieces = ids.filter((id) => id.startsWith(`${chapter}-`));
  if (sub === undefined && pieces.length > 0) {
    throw new RefError(`Часть ${name} разбита: ${pieces.join(', ')}. Укажите одну из них.`);
  }
  if (sub !== undefined && ids.includes(chapter)) {
    throw new RefError(`Части ${name} нет: глава ${chapter} не разбита, её часть — ${chapter}.`);
  }
  throw new RefError(`Части ${name} нет в книге: нет файла ${path.join(partsDir, `${name}.md`)}.`);
}

async function ensureDir(dir, message) {
  try {
    if ((await stat(dir)).isDirectory()) return;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
  throw new RefError(message);
}

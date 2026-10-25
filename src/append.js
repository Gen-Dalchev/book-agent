// Ввод кусок за куском (Б-09): кусок текста — следующая глава книги, parts/NNN.md без
// подглав и строка в оглавлении book.md; в новой или пустой папке первый кусок заводит книгу.
// Готовые части не трогаются; book.md правится построчно, прочие его строки — байт в байт.
// Всё или ничего: сначала все проверки и сборка, потом запись; при ошибке папка — как до команды.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { detectFormat } from './format.js';
import { INDEX_FILE, PARTS_DIR, partId, renderIndex, tableRow } from './layout.js';
import { BLANK, DEFINITION, FENCE, HEADING, PART_NAME, SEPARATOR, splitBlocks } from './refs.js';
import { countWords } from './words.js';
import { ImportError } from './errors.js';

const TEMP_FILE = '.book.md.tmp';
const UNTITLED = 'Без названия';
const TITLE_LINE = /^# /;
const HAS_TEXT = /[\p{L}\p{N}]/u;
const PART_FILE = /^\d{3}(?:-\d{2})?\.md$/;
const TOC_HEADING = '## Оглавление';
const MAX_CHAPTER = 999;
const CHAPTERS_LINE = /^- Глав: (\d+)$/;
const PARTS_LINE = /^- Частей: (\d+)$/;
const FOOTNOTES_LINE = /^- Сносок: (\d+)$/;
// Метка сноски в заголовке и пробелы перед ней: в оглавлении её нет, как у импорта (#16).
const MARK = /[^\S\n]*\[\^\d+\]/g;
const NOTHING_WRITTEN = 'Ничего не записано.';

/**
 * @param {Uint8Array} data кусок: содержимое файла или вставка
 * @param {string} bookDir папка книги после импорта или новая (пустая) папка
 * @param {object} [options]
 * @param {string} [options.title] заголовок части — важнее строки «# …» в куске
 * @param {boolean} [options.again] дописать, даже если такой кусок уже есть
 * @param {string} [options.bookTitle] название новой книги (только для новой или пустой папки)
 * @param {string} [options.author] автор новой книги
 * @returns {Promise<{title: string, part: string, paragraphs: number}>}
 */
export async function appendPiece(data, bookDir, options = {}) {
  const { title: titleOption, again = false, bookTitle, author } = options;
  if (titleOption !== undefined && oneLine(titleOption) === '') {
    throw new ImportError(`пустой --title: укажите заголовок части или уберите ключ. ${NOTHING_WRITTEN}`);
  }
  const piece = buildPiece(data, titleOption);
  const book = await readBook(bookDir);

  if (book.isNew) {
    if (bookTitle === undefined || oneLine(bookTitle) === '') {
      throw new ImportError(`папки книги ${bookDir} ещё нет или она пуста — первая порция заводит книгу, `
        + `нужно её название: --book-title "…" (и, если знаете, --author "…"). ${NOTHING_WRITTEN}`);
    }
  } else if (bookTitle !== undefined || author !== undefined) {
    throw new ImportError(`книга уже заведена — не та папка? В ${bookDir} уже есть ${INDEX_FILE}; `
      + `--book-title и --author нужны только для первой порции новой книги. ${NOTHING_WRITTEN}`);
  }

  const id = partId(book.isNew ? 1 : book.lastChapter + 1);
  if (!book.isNew) {
    if (book.lastChapter + 1 > MAX_CHAPTER) {
      throw new ImportError(`в книге уже ${MAX_CHAPTER} глав — номер новой части вышел бы больше ${MAX_CHAPTER}. ${NOTHING_WRITTEN}`);
    }
    const twin = again ? undefined : book.bodies.find(({ body }) => body === bodyOf(piece.content));
    if (twin) {
      throw new ImportError(`такой кусок уже есть: часть ${twin.id}. Если его и правда нужно дописать ещё раз — `
        + `ключ --again. ${NOTHING_WRITTEN}`);
    }
  }

  const file = `${PARTS_DIR}/${id}.md`;
  const row = [id, piece.title.replace(MARK, ''), file, countWords(piece.content)];
  const index = book.isNew
    ? renderIndex({ title: oneLine(bookTitle), authors: author ? [oneLine(author)] : [] }, 1, 1, piece.footnotes, [row])
    : updateIndex(book, row, piece.footnotes);
  await writeBook(bookDir, file, piece.content, index);
  return { title: piece.title, part: id, paragraphs: piece.paragraphs };
}

/** Кусок → файл части: заголовок, абзацы через пустую строку, перевод строки в конце. */
function buildPiece(data, titleOption) {
  if (detectFormat(data) !== null) {
    throw new ImportError('EPUB и PDF порцией не дописываются — импортируйте файл целиком в отдельную папку '
      + '(npm run import -- <файл> <папка>), а кусок возьмите из её части.');
  }
  let text;
  try {
    // TextDecoder сам снимает BOM в начале.
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new ImportError(`кусок не в UTF-8: сохраните текст в кодировке UTF-8. ${NOTHING_WRITTEN}`);
  }
  let lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd());

  // Первая непустая строка «# …» — заголовок части; из текста она уходит всегда.
  const first = lines.findIndex((line) => !BLANK.test(line));
  const titled = first !== -1 && TITLE_LINE.test(lines[first]);
  const heading = titled ? lines[first].slice(2) : '';
  if (titled) lines = lines.slice(first + 1);
  if (!lines.some((line) => HAS_TEXT.test(line))) {
    throw new ImportError(`кусок пуст: в нём нет текста${titled ? ', кроме заголовка' : ''}. ${NOTHING_WRITTEN}`);
  }

  const title = oneLine(titleOption ?? heading) || UNTITLED;
  const content = `# ${title}\n\n${splitPiece(lines).join('\n\n')}\n`;
  const blocks = splitBlocks(content);
  const definitions = blocks.find((block) => block.kind === 'definitions');
  return {
    title,
    content,
    paragraphs: blocks.filter((block) => block.kind === 'paragraph').length,
    footnotes: definitions ? definitions.text.split('\n').length : 0,
  };
}

/**
 * Строки куска (без строки заголовка) → блоки. Есть пустые строки — абзацы по ним;
 * нет — каждая строка абзацем. Блок кода в ``` — один блок в обоих случаях (Б-04).
 */
function splitPiece(allLines) {
  let start = 0;
  let end = allLines.length;
  while (start < end && BLANK.test(allLines[start])) start += 1;
  while (end > start && BLANK.test(allLines[end - 1])) end -= 1;
  const lines = allLines.slice(start, end);

  let inFence = false;
  let hasBlank = false;
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence && BLANK.test(line)) hasBlank = true;
  }
  return hasBlank ? blocksByBlankLines(lines) : blocksByLines(lines);
}

// Заголовок и разделитель — всегда отдельный блок: иначе splitBlocks сочтёт заголовком и текст под ним.
function isStandalone(line) {
  return HEADING.test(line) || SEPARATOR.test(line.trim());
}

function blocksByBlankLines(lines) {
  const blocks = [];
  let current = [];
  let inFence = false;
  const flush = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    if (inFence) {
      current.push(line);
      if (FENCE.test(line)) inFence = false;
    } else if (BLANK.test(line)) {
      flush();
    } else if (isStandalone(line)) {
      flush();
      blocks.push(line);
    } else {
      if (FENCE.test(line)) inFence = true;
      current.push(line);
    }
  }
  flush();
  return blocks;
}

function blocksByLines(lines) {
  const blocks = [];
  let fence = null;
  for (const line of lines) {
    if (fence) {
      fence.push(line);
      if (FENCE.test(line)) {
        blocks.push(fence.join('\n'));
        fence = null;
      }
    } else if (FENCE.test(line)) {
      fence = [line];
    } else {
      blocks.push(line);
    }
  }
  if (fence) blocks.push(fence.join('\n'));
  // Строки «[^N]: » подряд в конце куска — один блок определений сносок (#16), а не абзацы.
  let tail = blocks.length;
  while (tail > 0 && DEFINITION.test(blocks[tail - 1])) tail -= 1;
  if (blocks.length - tail > 1) blocks.splice(tail, blocks.length - tail, blocks.slice(tail).join('\n'));
  return blocks;
}

/** Тело части для сравнения кусков: без строки «# заголовок» и пустой строки после неё. */
function bodyOf(markdown) {
  const lines = markdown.split('\n');
  if (!TITLE_LINE.test(lines[0])) return markdown;
  return lines.slice(lines[1] === '' ? 2 : 1).join('\n');
}

function oneLine(text) {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * Что есть в папке: новая (нет или пуста) или готовая книга — строки book.md, наибольший
 * номер главы, где стоят счётчики и последняя строка оглавления, тела частей.
 */
async function readBook(bookDir) {
  let entries;
  try {
    entries = await readdir(bookDir);
  } catch (error) {
    if (error.code === 'ENOENT') return { isNew: true };
    if (error.code === 'ENOTDIR') throw new ImportError(`${bookDir} — это файл, а не папка книги. ${NOTHING_WRITTEN}`);
    throw error;
  }
  if (entries.length === 0) return { isNew: true };
  if (!entries.includes(INDEX_FILE)) {
    throw new ImportError(`в папке ${bookDir} есть файлы, но нет ${INDEX_FILE} — это не папка книги после импорта. `
      + `Для новой книги укажите новую или пустую папку. ${NOTHING_WRITTEN}`);
  }

  const index = await readFile(path.join(bookDir, INDEX_FILE), 'utf8');
  if (index.includes('\r')) {
    throw new ImportError(`${INDEX_FILE} не в формате импорта: в нём переводы строк не те, что пишет импорт (CRLF). ${NOTHING_WRITTEN}`);
  }
  const lines = index.split('\n');
  const { lastChapter, lastRow } = readContents(lines);
  if (lastChapter === null) {
    throw new ImportError(`в оглавлении ${INDEX_FILE} нет ни одной строки части — это не оглавление импорта. ${NOTHING_WRITTEN}`);
  }
  const chaptersAt = lines.findIndex((line) => CHAPTERS_LINE.test(line));
  const partsAt = lines.findIndex((line) => PARTS_LINE.test(line));
  if (chaptersAt === -1 || partsAt === -1) {
    throw new ImportError(`в ${INDEX_FILE} нет строки «Глав» или «Частей» — это не шапка импорта. ${NOTHING_WRITTEN}`);
  }

  const bodies = await readParts(path.join(bookDir, PARTS_DIR));
  const partsLast = bodies.length ? Math.max(...bodies.map(({ id }) => Number(id.slice(0, 3)))) : null;
  if (partsLast !== lastChapter) {
    throw new ImportError(`${INDEX_FILE} и ${PARTS_DIR}/ разошлись: последняя глава в оглавлении — ${partId(lastChapter)}, `
      + `в ${PARTS_DIR}/ — ${partsLast === null ? 'ни одной части' : partId(partsLast)}. ${NOTHING_WRITTEN}`);
  }
  return {
    isNew: false,
    lines,
    lastChapter,
    lastRow,
    chaptersAt,
    partsAt,
    footnotesAt: lines.findIndex((line) => FOOTNOTES_LINE.test(line)),
    bodies,
  };
}

// Таблица под «## Оглавление» (до следующего «## » или конца файла): наибольший номер главы
// по первому столбцу и последняя строка таблицы. Строки с другим первым столбцом пропускаются.
function readContents(lines) {
  let lastChapter = null;
  let lastRow = -1;
  const start = lines.indexOf(TOC_HEADING);
  if (start === -1) return { lastChapter, lastRow };
  for (let at = start + 1; at < lines.length && !lines[at].startsWith('## '); at += 1) {
    const line = lines[at];
    if (!line.startsWith('|')) {
      if (lastRow !== -1) break;
      continue;
    }
    lastRow = at;
    const match = line.split('|')[1].trim().match(PART_NAME);
    if (match) lastChapter = Math.max(lastChapter ?? 0, Number(match[1]));
  }
  return { lastChapter, lastRow };
}

/** Тела готовых частей по порядку имён; файлы с другими именами пропускаются. */
async function readParts(partsDir) {
  let entries;
  try {
    entries = await readdir(partsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
  const names = entries.filter((entry) => entry.isFile() && PART_FILE.test(entry.name)).map((entry) => entry.name).sort();
  return Promise.all(names.map(async (name) => ({
    id: name.slice(0, -'.md'.length),
    body: bodyOf(await readFile(path.join(partsDir, name), 'utf8')),
  })));
}

/** Новый book.md: строка оглавления после последней строки таблицы, счётчики — плюс новая часть. */
function updateIndex(book, row, footnotes) {
  const lines = [...book.lines];
  const add = (at, amount) => {
    lines[at] = lines[at].replace(/\d+$/, (value) => String(Number(value) + amount));
  };
  add(book.chaptersAt, 1);
  add(book.partsAt, 1);
  if (book.footnotesAt !== -1) add(book.footnotesAt, footnotes);
  lines.splice(book.lastRow + 1, 0, tableRow(row));
  return lines.join('\n');
}

// Сначала часть — только новым файлом, потом book.md через временный файл и переименование.
// Сбой — убирается всё, что команда успела создать: часть, временный файл, свои папки.
async function writeBook(bookDir, file, content, index) {
  const partPath = path.join(bookDir, ...file.split('/'));
  const tempPath = path.join(bookDir, TEMP_FILE);
  const made = [];
  let createdDir;
  let writing = file;
  try {
    // mkdir отдаёт первую созданную папку (или undefined, если всё уже было) — её и убирать при сбое.
    createdDir = await mkdir(bookDir, { recursive: true });
    const createdParts = await mkdir(path.dirname(partPath), { recursive: true });
    createdDir ??= createdParts;
    await createFile(partPath, content, made);
    writing = TEMP_FILE;
    await createFile(tempPath, index, made);
    writing = INDEX_FILE;
    await rename(tempPath, path.join(bookDir, INDEX_FILE));
  } catch (error) {
    for (const target of made.reverse()) await rm(target, { force: true });
    if (createdDir) await rm(createdDir, { recursive: true, force: true });
    const reason = error.code === 'EEXIST' ? `${writing} уже есть в папке книги — уберите его` : error.message;
    throw new ImportError(`не удалось записать ${writing}: ${reason}. ${NOTHING_WRITTEN}`, { cause: error });
  }
}

// Файл, которого не было: «wx» не перезаписывает чужое; созданный — в made, чтобы убрать при сбое.
async function createFile(target, content, made) {
  try {
    await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    // Открыть удалось, записать — нет: файл наш, его убирают вместе с остальным.
    if (error.code !== 'EEXIST') made.push(target);
    throw error;
  }
  made.push(target);
}

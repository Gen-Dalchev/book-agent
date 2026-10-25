// Раскладка книги на диске: какие файлы и с каким содержимым. Черновая
// (book.md + parts/NNN[-MM].md): окончательную утвердит владелец, поэтому
// имена файлов и вид оглавления собраны здесь и больше нигде.
import { countNoteDefinitions } from './footnotes.js';

export const INDEX_FILE = 'book.md';
export const PARTS_DIR = 'parts';
const INTRO_TITLE = 'Начало главы';

/** Номер части: «003» для главы целиком, «003-00» и «003-01» для её кусков. */
export function partId(chapterNumber, subNumber = null) {
  const chapter = String(chapterNumber).padStart(3, '0');
  return subNumber === null ? chapter : `${chapter}-${String(subNumber).padStart(2, '0')}`;
}

/**
 * @param {{metadata: import('./epub.js').Metadata,
 *   chapters: import('./chapters.js').Chapter[],
 *   skipped?: {file: string, start: string, reason: string}[]}} book
 *   skipped — служебные страницы: файл в архиве, первые слова, причина
 * @returns {{files: {path: string, content: string}[], chapterCount: number, partCount: number}}
 */
export function planBook({ metadata, chapters, skipped = [] }) {
  const files = [];
  const rows = [];

  chapters.forEach((chapter, index) => {
    const number = index + 1;
    const whole = chapter.parts.length === 1 && chapter.parts[0].kind === 'whole';
    if (whole) {
      const part = chapter.parts[0];
      const file = `${PARTS_DIR}/${partId(number)}.md`;
      files.push({ path: file, content: part.markdown });
      rows.push([partId(number), chapter.title, file, part.words]);
      return;
    }
    const total = chapter.parts.reduce((sum, part) => sum + part.words, 0);
    rows.push([partId(number), chapter.title, '—', total]);
    let sub = 1;
    for (const part of chapter.parts) {
      const id = partId(number, part.kind === 'intro' ? 0 : sub++);
      const file = `${PARTS_DIR}/${id}.md`;
      files.push({ path: file, content: part.markdown });
      rows.push([id, part.kind === 'intro' ? INTRO_TITLE : part.title, file, part.words]);
    }
  });

  const partCount = files.length;
  const noteCount = files.reduce((sum, file) => sum + countNoteDefinitions(file.content), 0);
  files.unshift({
    path: INDEX_FILE,
    content: renderIndex(metadata, chapters.length, partCount, noteCount, rows, skipped),
  });
  return { files, chapterCount: chapters.length, partCount };
}

function renderIndex(metadata, chapterCount, partCount, noteCount, rows, skipped) {
  const list = (values = []) => values.join(', ') || 'не указан';
  const lines = [
    `# ${metadata.title || 'Без названия'}`,
    '',
    `- Автор: ${list(metadata.authors)}`,
    `- Язык: ${metadata.language || 'не указан'}`,
    `- Переводчик: ${list(metadata.translators)}`,
    `- Издатель: ${list(metadata.publishers)}`,
    `- Год: ${metadata.year || 'не указан'}`,
    `- ISBN: ${list(metadata.isbns)}`,
    `- Глав: ${chapterCount}`,
    `- Частей: ${partCount}`,
    `- Сносок: ${noteCount}`,
    '',
    '## Оглавление',
    '',
    '| Часть | Заголовок | Файл | Слов |',
    '| --- | --- | --- | ---: |',
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
  if (skipped.length > 0) {
    lines.push(
      '',
      '## Пропущено',
      '',
      '| Файл | Начало | Причина |',
      '| --- | --- | --- |',
      ...skipped.map((page) => `| ${[page.file, page.start, page.reason].map(cell).join(' | ')} |`),
    );
  }
  return `${lines.join('\n')}\n`;
}

function cell(value) {
  return String(value).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
}

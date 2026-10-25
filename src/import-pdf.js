// Импорт PDF с текстовым слоем: прочитать файл → строки и абзацы → главы по закладкам
// (без закладок — по крупному шрифту) →
// записать папку книги в той же раскладке, что у EPUB. Всё проверяется до записи.
import { textLines } from './pdf-text.js';
import { findHeadings } from './pdf-headings.js';
import { chaptersFromBookmarks, chaptersFromHeadings, singleChapter } from './pdf-chapters.js';
import { planBook } from './layout.js';
import { writeFiles } from './write.js';
import { ImportError } from './errors.js';

export const NO_BOOKMARKS_WARNING = 'в PDF нет закладок — главы не размечены';
export const FONT_HEADINGS_WARNING = 'в PDF нет закладок — главы размечены по крупному шрифту, проверьте оглавление в book.md';

/**
 * @param {Uint8Array} data содержимое файла .pdf
 * @param {string} outDir папка книги: проверена заранее, новая или пустая
 * @returns {Promise<{title: string, chapterCount: number, partCount: number, warnings: string[]}>}
 */
export async function importPdfData(data, outDir) {
  // pdfjs тяжёлый — грузим его, только когда пришёл PDF.
  const { readPdf } = await import('./pdf.js');
  const book = await readPdf(data);
  const lines = textLines(book.pages, book.boxes);
  if (lines.length === 0) {
    throw new ImportError('В PDF нет текстового слоя — похоже на скан; такие пока не поддерживаются.');
  }

  const warnings = [];
  let chapters;
  if (book.bookmarks.length > 0) {
    chapters = chaptersFromBookmarks(lines, book.bookmarks);
  } else {
    // Без закладок — главы по крупному шрифту; не нашлись — книга одной главой.
    const headings = findHeadings(lines);
    if (headings.length > 0) {
      warnings.push(FONT_HEADINGS_WARNING);
      chapters = chaptersFromHeadings(lines, headings);
    } else {
      warnings.push(NO_BOOKMARKS_WARNING);
      chapters = singleChapter(lines);
    }
  }
  const plan = planBook({ metadata: book.metadata, chapters });
  await writeFiles(outDir, plan.files);
  return { title: book.metadata.title, chapterCount: plan.chapterCount, partCount: plan.partCount, warnings };
}

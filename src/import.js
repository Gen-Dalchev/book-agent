// Импорт книги любого поддержанного формата: формат — по содержимому файла
// (format.js), дальше — импорт EPUB или PDF в одну и ту же раскладку.
import path from 'node:path';
import { detectFormat } from './format.js';
import { importEpubData } from './import-epub.js';
import { importPdfData } from './import-pdf.js';
import { readInput } from './input.js';
import { ensureEmptyDir } from './write.js';
import { ImportError } from './errors.js';

/**
 * @param {string} inputPath файл .epub или .pdf
 * @param {string} outDir папка книги: не должна существовать или должна быть пустой
 * @param {{all?: boolean}} [options] all — служебные страницы EPUB не пропускать; на PDF не влияет
 * @returns {Promise<{title: string, chapterCount: number, partCount: number, warnings: string[]}>}
 */
export async function importBook(inputPath, outDir, options = {}) {
  await ensureEmptyDir(outDir);
  const data = await readInput(inputPath);
  const format = detectFormat(data);
  if (format === 'pdf') return importPdfData(data, outDir);
  // Файл .epub, который не zip, разбор EPUB встречает своей ошибкой — как и раньше.
  if (format === 'epub' || path.extname(inputPath).toLowerCase() === '.epub') {
    return { ...(await importEpubData(data, outDir, options)), warnings: [] };
  }
  throw new ImportError('Файл не похож на PDF или EPUB.');
}

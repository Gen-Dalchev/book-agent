// Импорт книги любого поддержанного формата: формат — по содержимому файла
// (format.js), дальше — импорт EPUB, PDF или FB2 в одну и ту же раскладку.
import path from 'node:path';
import { detectFormat } from './format.js';
import { importEpubData } from './import-epub.js';
import { importPdfData } from './import-pdf.js';
import { importFb2Data } from './import-fb2.js';
import { fb2FromZip } from './fb2.js';
import { readInput } from './input.js';
import { ensureEmptyDir } from './write.js';
import { ImportError } from './errors.js';

/**
 * @param {string} inputPath файл .epub, .pdf, .fb2 или .fb2.zip
 * @param {string} outDir папка книги: не должна существовать или должна быть пустой
 * @param {{all?: boolean}} [options] all — служебные страницы EPUB не пропускать; на PDF и FB2 не влияет
 * @returns {Promise<{title: string, chapterCount: number, partCount: number, warnings: string[]}>}
 */
export async function importBook(inputPath, outDir, options = {}) {
  await ensureEmptyDir(outDir);
  const data = await readInput(inputPath);
  const format = detectFormat(data);
  if (format === 'pdf') return importPdfData(data, outDir);
  if (format === 'fb2') return importFb2Data(data, outDir);
  // Zip без container.xml с одним .fb2 внутри — FB2; иначе — EPUB с его ошибками.
  const fb2 = format === 'epub' ? await fb2FromZip(data) : null;
  if (fb2) return importFb2Data(fb2, outDir);
  // Файл .epub, который не zip, разбор EPUB встречает своей ошибкой — как и раньше.
  if (format === 'epub' || path.extname(inputPath).toLowerCase() === '.epub') {
    return importEpubData(data, outDir, options);
  }
  throw new ImportError('Файл не похож на PDF или EPUB, и это не FB2.');
}

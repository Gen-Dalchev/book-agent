// Чтение исходного файла книги с понятной ошибкой, если его нет.
import { readFile } from 'node:fs/promises';
import { ImportError } from './errors.js';

/**
 * @param {string} inputPath
 * @param {string} [wanted] что за файл нужен — для ошибки, если указана папка
 * @returns {Promise<Uint8Array>}
 */
export async function readInput(inputPath, wanted = 'файл книги (.epub или .pdf)') {
  try {
    return await readFile(inputPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new ImportError(`Файл не найден: ${inputPath}`);
    if (error.code === 'EISDIR') throw new ImportError(`${inputPath} — это папка, а нужен ${wanted}.`);
    throw error;
  }
}

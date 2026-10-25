// Чтение исходного файла книги с понятной ошибкой, если его нет.
import { readFile } from 'node:fs/promises';
import { ImportError } from './errors.js';

/** @returns {Promise<Uint8Array>} */
export async function readInput(inputPath) {
  try {
    return await readFile(inputPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new ImportError(`Файл не найден: ${inputPath}`);
    if (error.code === 'EISDIR') throw new ImportError(`${inputPath} — это папка, а нужен файл книги (.epub или .pdf).`);
    throw error;
  }
}

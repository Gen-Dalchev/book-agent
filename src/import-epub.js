// Импорт EPUB целиком: прочитать архив → нарезать на части → записать папку книги.
// Всё проверяется до записи: при ошибке папка не создаётся.
import { readFile } from 'node:fs/promises';
import { readEpub } from './epub.js';
import { htmlToBlocks } from './html-to-blocks.js';
import { buildChapters } from './chapters.js';
import { planBook } from './layout.js';
import { ensureEmptyDir, writeFiles } from './write.js';
import { ImportError } from './errors.js';

/**
 * @param {string} inputPath файл .epub
 * @param {string} outDir папка книги: не должна существовать или должна быть пустой
 * @returns {Promise<{title: string, chapterCount: number, partCount: number}>}
 */
export async function importEpub(inputPath, outDir) {
  await ensureEmptyDir(outDir);
  const data = await readInput(inputPath);
  const { metadata, documents } = await readEpub(data);
  const chapters = buildChapters(documents.map((doc) => htmlToBlocks(doc.html)));
  if (chapters.length === 0) {
    throw new ImportError('В книге не нашлось текста: все файлы в порядке чтения пустые.');
  }
  const plan = planBook({ metadata, chapters });
  await writeFiles(outDir, plan.files);
  return { title: metadata.title, chapterCount: plan.chapterCount, partCount: plan.partCount };
}

async function readInput(inputPath) {
  try {
    return await readFile(inputPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new ImportError(`Файл не найден: ${inputPath}`);
    if (error.code === 'EISDIR') throw new ImportError(`${inputPath} — это папка, а нужен файл .epub.`);
    throw error;
  }
}

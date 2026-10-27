// Импорт FB2 (Б-14): прочитать файл (fb2.js) → главы из секций (fb2-chapters.js) →
// записать папку книги в той же раскладке, что у EPUB. Всё проверяется до записи.
import { readFb2 } from './fb2.js';
import { fb2Chapters } from './fb2-chapters.js';
import { planBook } from './layout.js';
import { writeFiles } from './write.js';
import { ImportError } from './errors.js';

/**
 * @param {Uint8Array} data содержимое файла .fb2 (или .fb2 из .fb2.zip)
 * @param {string} outDir папка книги: проверена заранее, новая или пустая
 * @returns {Promise<{title: string, chapterCount: number, partCount: number, warnings: string[]}>}
 */
export async function importFb2Data(data, outDir) {
  const book = readFb2(data);
  const chapters = fb2Chapters(book.bodies);
  if (chapters.length === 0) throw new ImportError('В книге FB2 не нашлось текста.');
  const plan = planBook({ metadata: book.metadata, chapters });
  await writeFiles(outDir, plan.files);
  return { title: book.metadata.title, chapterCount: plan.chapterCount, partCount: plan.partCount, warnings: [] };
}

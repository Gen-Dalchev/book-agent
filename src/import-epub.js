// Импорт EPUB целиком: прочитать архив → отложить служебные страницы → нарезать
// на части → записать папку книги. Всё проверяется до записи: при ошибке папка не создаётся.
import { readEpub } from './epub.js';
import { readInput } from './input.js';
import { htmlToBlocks } from './html-to-blocks.js';
import { buildChapters, fallbackTitle } from './chapters.js';
import { frontMatterReasons } from './front-matter.js';
import { planBook } from './layout.js';
import { ensureEmptyDir, writeFiles } from './write.js';
import { ImportError } from './errors.js';

/**
 * @param {string} inputPath файл .epub
 * @param {string} outDir папка книги: не должна существовать или должна быть пустой
 * @param {{all?: boolean}} [options] all — служебные страницы не пропускать
 * @returns {Promise<{title: string, chapterCount: number, partCount: number}>}
 */
export async function importEpub(inputPath, outDir, options = {}) {
  await ensureEmptyDir(outDir);
  return importEpubData(await readInput(inputPath), outDir, options);
}

/**
 * То же для уже прочитанного файла: формат определил общий импорт (import.js).
 * @param {Uint8Array} data содержимое файла .epub
 * @param {string} outDir папка книги: проверена заранее, новая или пустая
 * @param {{all?: boolean}} [options]
 */
export async function importEpubData(data, outDir, { all = false } = {}) {
  const book = await readEpub(data);
  const documents = book.documents.map((doc) => ({ ...doc, blocks: htmlToBlocks(doc.html).blocks }));
  const reasons = all ? documents.map(() => null) : frontMatterReasons({ ...book, documents });

  const kept = [];
  const skipped = [];
  documents.forEach((doc, index) => {
    const reason = reasons[index];
    if (reason) skipped.push({ file: doc.href, start: fallbackTitle(doc.blocks), reason });
    else kept.push(doc);
  });

  const chapters = buildChapters(kept);
  if (chapters.length === 0 && skipped.length > 0) {
    throw new ImportError('В книге не нашлось текста: все страницы — служебные (обложка, титул, выходные данные, оглавление). Чтобы взять всё, добавьте --all.');
  }
  if (chapters.length === 0) {
    throw new ImportError('В книге не нашлось текста: все файлы в порядке чтения пустые.');
  }
  const plan = planBook({ metadata: book.metadata, chapters, skipped });
  await writeFiles(outDir, plan.files);
  return { title: book.metadata.title, chapterCount: plan.chapterCount, partCount: plan.partCount };
}

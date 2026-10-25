// Импорт EPUB целиком: прочитать архив → отложить служебные страницы → разобрать
// сноски по всей книге → нарезать на части → записать папку книги. Всё проверяется до записи: при ошибке папка не создаётся.
import { readEpub } from './epub.js';
import { readInput } from './input.js';
import { blocksWithoutFootnotes, documentsToBlocks, htmlToBlocks } from './html-to-blocks.js';
import { buildChapters, fallbackTitle } from './chapters.js';
import { frontMatterReasons } from './front-matter.js';
import { planBook } from './layout.js';
import { ensureEmptyDir, writeFiles } from './write.js';
import { ImportError } from './errors.js';

const HAS_TEXT = /[\p{L}\p{N}]/u;
// Причина в «Пропущено» для файла примечаний, из которого всё разнесено по частям.
export const NOTES_REASON = 'примечания — разнесены по частям';

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
  // Служебные страницы — по каждому документу отдельно, со сносками только внутри
  // своего файла (#16). Ссылка в служебную страницу — не сноска, даже с --all.
  const single = book.documents.map((doc) => ({ ...doc, ...htmlToBlocks(doc.html, { href: doc.href }) }));
  const reasons = frontMatterReasons({ ...book, documents: single });
  const closed = new Set(single.filter((_doc, index) => reasons[index]).map((doc) => doc.href));
  const documents = documentsToBlocks(book.documents, { closed });

  const kept = [];
  const skipped = [];
  book.documents.forEach(({ href, html }, index) => {
    const doc = documents[index];
    const reason = all ? null : reasons[index];
    if (reason) {
      skipped.push({ file: href, start: fallbackTitle(single[index].blocks), reason });
    } else if (doc.notesFile && !hasText(doc.blocks)) {
      // Первые слова — до вырезания примечаний: после него блоков может не остаться.
      const before = blocksWithoutFootnotes(html);
      const start = before.some((block) => HAS_TEXT.test(block.text)) ? fallbackTitle(before) : '';
      skipped.push({ file: href, start, reason: NOTES_REASON });
    } else {
      kept.push(doc);
    }
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

// Остался ли текст, кроме заголовков и <hr>: файл примечаний без него частью не становится.
function hasText(blocks) {
  return blocks.some((block) => block.type === 'text' && HAS_TEXT.test(block.text));
}

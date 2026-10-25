// Чтение PDF библиотекой pdfjs-dist (Б-05): сведения о книге, куски текста страниц, закладки.
// Здесь только разбор файла; строки и абзацы собирает pdf-text.js, главы — pdf-chapters.js.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ImportError } from './errors.js';

// Уровень сообщений pdfjs: только ошибки, без предупреждений о шрифтах в консоль.
const VERBOSITY_ERRORS = 0;

/**
 * @param {Uint8Array} data содержимое файла .pdf
 * @returns {Promise<{metadata: import('./epub.js').Metadata,
 *   pages: import('./pdf-text.js').TextItem[][],
 *   bookmarks: import('./pdf-chapters.js').Bookmark[]}>} bookmarks пустой — закладок нет
 */
export async function readPdf(data) {
  // pdfjs забирает буфер себе — отдаём копию.
  const task = getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: VERBOSITY_ERRORS,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (cause) {
    await task.destroy();
    if (cause?.name === 'PasswordException') {
      throw new ImportError('PDF защищён паролем — такие пока не поддерживаются. Снимите пароль и повторите.', { cause });
    }
    throw new ImportError('Файл не читается как PDF: он повреждён или обрезан.', { cause });
  }

  try {
    const { info } = await doc.getMetadata().catch(() => ({ info: {} }));
    const pages = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items.filter((item) => typeof item.str === 'string'));
      page.cleanup();
    }
    const outline = (await doc.getOutline().catch(() => null)) ?? [];
    const bookmarks = await resolveBookmarks(doc, outline, 1);
    return { metadata: readMetadata(info ?? {}), pages, bookmarks };
  } catch (cause) {
    if (cause instanceof ImportError) throw cause;
    throw new ImportError('PDF повреждён: не удалось прочитать страницы.', { cause });
  } finally {
    await task.destroy();
  }
}

function readMetadata(info) {
  const text = (value) => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '');
  const author = text(info.Author);
  return {
    title: text(info.Title),
    authors: author ? [author] : [],
    language: text(info.Language),
    translators: [],
    publishers: [],
    year: '',
    isbns: [],
  };
}

// Закладки глубже второго уровня текст не делят: их не разбираем.
const MAX_DEPTH = 2;

async function resolveBookmarks(doc, items, depth) {
  const bookmarks = [];
  for (const item of items) {
    const place = await destinationPlace(doc, item.dest);
    // Закладка без места в книге (ссылка наружу, битое назначение) главы не даёт.
    if (!place) continue;
    const children = depth < MAX_DEPTH ? await resolveBookmarks(doc, item.items ?? [], depth + 1) : [];
    bookmarks.push({ title: item.title ?? '', ...place, children });
  }
  return bookmarks;
}

// Назначение — массив [страница, {name: вид}, ...числа] или имя такого массива.
async function destinationPlace(doc, dest) {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const [target, view] = explicit;
    const page = typeof target === 'number' ? target : await doc.getPageIndex(target);
    return { page, y: topOf(view?.name, explicit) };
  } catch {
    return null;
  }
}

// Верх видимой области: XYZ — [стр, XYZ, left, top, zoom], FitH/FitBH — [стр, вид, top],
// FitR — [стр, FitR, left, bottom, right, top]. Остальные виды — страница целиком.
function topOf(view, dest) {
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  if (view === 'XYZ') return number(dest[3]);
  if (view === 'FitH' || view === 'FitBH') return number(dest[2]);
  if (view === 'FitR') return number(dest[5]);
  return null;
}

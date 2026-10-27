// Формат книги — по первым байтам файла, а не по расширению: «книга.pdf»
// может оказаться EPUB и наоборот.
const PDF_SIGNATURE = '%PDF-';
// Обычный zip начинается с записи файла (PK 03 04), пустой — с конца каталога (PK 05 06).
const ZIP_SIGNATURES = [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]];
const UTF8_BOM = [0xef, 0xbb, 0xbf];
// FB2 — XML, первый элемент которого FictionBook; до него — пролог, комментарии, DOCTYPE.
const FB2_HEAD = 64 * 1024;
const FB2_START = /^\s*(?:(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>)\s*)*<(?:[\w.-]+:)?FictionBook[\s/>]/;

/**
 * @param {Uint8Array} data содержимое файла
 * @returns {'pdf' | 'epub' | 'fb2' | null} epub — любой zip: EPUB ли это (или FB2 в zip), проверит разбор архива
 */
export function detectFormat(data) {
  if (startsWith(data, [...PDF_SIGNATURE].map((char) => char.charCodeAt(0)))) return 'pdf';
  if (ZIP_SIGNATURES.some((signature) => startsWith(data, signature))) return 'epub';
  if (isFb2(data)) return 'fb2';
  return null;
}

function isFb2(data) {
  const start = startsWith(data, UTF8_BOM) ? UTF8_BOM.length : 0;
  // Разметка до FictionBook — латиница: кодировка книги здесь не важна.
  const head = new TextDecoder('latin1').decode(data.subarray(start, start + FB2_HEAD));
  return FB2_START.test(head);
}

function startsWith(data, bytes) {
  return data.length >= bytes.length && bytes.every((byte, index) => data[index] === byte);
}

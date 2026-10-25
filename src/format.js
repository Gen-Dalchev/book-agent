// Формат книги — по первым байтам файла, а не по расширению: «книга.pdf»
// может оказаться EPUB и наоборот.
const PDF_SIGNATURE = '%PDF-';
// Обычный zip начинается с записи файла (PK 03 04), пустой — с конца каталога (PK 05 06).
const ZIP_SIGNATURES = [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]];

/**
 * @param {Uint8Array} data содержимое файла
 * @returns {'pdf' | 'epub' | null} epub — любой zip: EPUB ли это, проверит разбор архива
 */
export function detectFormat(data) {
  if (startsWith(data, [...PDF_SIGNATURE].map((char) => char.charCodeAt(0)))) return 'pdf';
  if (ZIP_SIGNATURES.some((signature) => startsWith(data, signature))) return 'epub';
  return null;
}

function startsWith(data, bytes) {
  return data.length >= bytes.length && bytes.every((byte, index) => data[index] === byte);
}

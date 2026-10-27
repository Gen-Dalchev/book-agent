// Собирает маленький FB2 из своего текста — тексты книг в репо не кладутся.
import JSZip from 'jszip';

/**
 * @param {object} book
 * @param {string} [book.titleInfo] XML внутри <title-info> как есть (без него — только название и язык)
 * @param {string} [book.publishInfo] XML внутри <publish-info>; без него — элемента нет
 * @param {string} book.bodies XML всех <body> как есть
 * @param {string} [book.encoding] кодировка в прологе; null — пролога нет
 */
export function fb2({ titleInfo, publishInfo, bodies, encoding = 'UTF-8' }) {
  const prolog = encoding === null ? '' : `<?xml version="1.0" encoding="${encoding}"?>\n`;
  return `${prolog}<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
<title-info>
${titleInfo ?? '<book-title>Своя книга</book-title><lang>ru</lang>'}
</title-info>
${publishInfo === undefined ? '' : `<publish-info>${publishInfo}</publish-info>`}
</description>
${bodies}
<binary id="pic" content-type="image/png">AAAA</binary>
</FictionBook>
`;
}

/** Текст в windows-1251: латиница и знаки ASCII как есть, кириллица А–я, Ё, ё. */
export function cp1251(text) {
  return Uint8Array.from([...text], (char) => {
    const code = char.codePointAt(0);
    if (code < 0x80) return code;
    if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
    if (char === 'Ё') return 0xa8;
    if (char === 'ё') return 0xb8;
    throw new Error(`нет в windows-1251 помощника: ${char}`);
  });
}

/** Zip с файлами {имя: содержимое}. */
export async function zipOf(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

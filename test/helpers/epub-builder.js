// Собирает маленький EPUB в памяти из своего текста — тексты книг в репо не кладутся.
import JSZip from 'jszip';

export function xhtml(body, title = 'Документ') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${title}</title>
  <style>p { text-indent: 1em; }</style>
  <script>console.log('не должно попасть в текст');</script>
</head>
<body>
${body}
</body>
</html>
`;
}

/**
 * @param {object} book
 * @param {{id: string, href: string, content: string | Uint8Array, mediaType?: string}[]} book.items
 *   файлы манифеста в том порядке, в каком лягут в архив
 * @param {string[]} book.spine id в порядке чтения
 */
export async function buildEpub({ title, author, language, items, spine }) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`);
  const manifest = items
    .map((item) => `    <item id="${item.id}" href="${item.href}" media-type="${item.mediaType ?? 'application/xhtml+xml'}"/>`)
    .join('\n');
  const itemrefs = spine.map((id) => `    <itemref idref="${id}"/>`).join('\n');
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">test-book</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator id="author">${author}</dc:creator>
    <dc:language>${language}</dc:language>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine>
${itemrefs}
  </spine>
</package>
`);
  for (const item of items) zip.file(`OEBPS/${item.href}`, item.content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

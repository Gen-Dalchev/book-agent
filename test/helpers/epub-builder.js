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
 * @param {{id: string, href: string, content: string | Uint8Array, mediaType?: string, properties?: string}[]} book.items
 *   файлы манифеста в том порядке, в каком лягут в архив
 * @param {(string | {id: string, linear: 'yes' | 'no'})[]} book.spine id в порядке чтения
 * @param {string} [book.author] без него — ни одного dc:creator (кроме тех, что в book.metadata)
 * @param {'2.0' | '3.0'} [book.version]
 * @param {string} [book.metadata] XML, дописываемый в <metadata> как есть
 * @param {string} [book.guide] содержимое <guide> (EPUB 2) — XML как есть
 * @param {string} [book.toc] id файла NCX в манифесте — атрибут spine@toc (EPUB 2)
 */
export async function buildEpub({ title, author, language, items, spine, version = '3.0', metadata = '', guide, toc }) {
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
    .map((item) => `    <item id="${item.id}" href="${item.href}" media-type="${item.mediaType ?? 'application/xhtml+xml'}"${
      item.properties ? ` properties="${item.properties}"` : ''}/>`)
    .join('\n');
  const itemrefs = spine
    .map((ref) => (typeof ref === 'string'
      ? `    <itemref idref="${ref}"/>`
      : `    <itemref idref="${ref.id}" linear="${ref.linear}"/>`))
    .join('\n');
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="uid">test-book</dc:identifier>
    <dc:title>${title}</dc:title>
${author === undefined ? '' : `    <dc:creator id="author">${author}</dc:creator>\n`}    <dc:language>${language}</dc:language>
${metadata}
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine${toc === undefined ? '' : ` toc="${toc}"`}>
${itemrefs}
  </spine>
${guide === undefined ? '' : `  <guide>\n${guide}\n  </guide>\n`}</package>
`);
  for (const item of items) zip.file(`OEBPS/${item.href}`, item.content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Пункт оглавления для navDocument и ncxDocument: без href — <span> (в NCX — без <content>).
 * @typedef {{title: string, href?: string, children?: TocEntry[]}} TocEntry
 */

/** Документ навигации EPUB 3 с <nav epub:type="toc">; extra — ещё разметка в body (landmarks). */
export function navDocument(entries, extra = '') {
  const list = (items) => `<ol>${items.map((item) => `<li>${item.href === undefined
    ? `<span>${item.title}</span>` : `<a href="${item.href}">${item.title}</a>`}${
    item.children?.length ? list(item.children) : ''}</li>`).join('')}</ol>`;
  return xhtml(`<nav epub:type="toc"><h1>Contents</h1>${list(entries)}</nav>${extra}`, 'Contents');
}

/** NCX (EPUB 2) с тем же деревом пунктов. */
export function ncxDocument(entries) {
  let order = 0;
  const points = (items) => items.map((item) => {
    order += 1;
    return `<navPoint id="p${order}" playOrder="${order}"><navLabel><text>${item.title}</text></navLabel>${
      item.href === undefined ? '' : `<content src="${item.href}"/>`}${points(item.children ?? [])}</navPoint>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="test-book"/></head>
  <docTitle><text>Книга</text></docTitle>
  <navMap>${points(entries)}</navMap>
</ncx>
`;
}

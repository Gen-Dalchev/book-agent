// Чтение EPUB: zip → container.xml → OPF → метаданные и документы в порядке spine.
// Здесь только разбор архива; в markdown документы переводит html-to-blocks.js.
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { ImportError } from './errors.js';

const HTML_MEDIA_TYPES = new Set(['application/xhtml+xml', 'text/html']);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => ['rootfile', 'item', 'itemref', 'title', 'creator', 'language'].includes(name),
});

/**
 * @param {Uint8Array} data содержимое файла .epub
 * @returns {Promise<{metadata: {title: string, authors: string[], language: string},
 *   documents: {href: string, html: string}[]}>}
 */
export async function readEpub(data) {
  let zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch (cause) {
    throw new ImportError('Файл не похож на EPUB: это не zip-архив или архив повреждён.', { cause });
  }

  const containerXml = await readText(zip, 'META-INF/container.xml');
  if (containerXml === null) {
    throw new ImportError('Это не EPUB: в архиве нет файла META-INF/container.xml.');
  }
  const rootfile = parseXml(containerXml, 'META-INF/container.xml')?.container?.rootfiles?.rootfile?.[0];
  const opfPath = rootfile?.['@_full-path'];
  if (!opfPath) {
    throw new ImportError('EPUB повреждён: в META-INF/container.xml не указан файл описания книги.');
  }

  const opfXml = await readText(zip, opfPath);
  if (opfXml === null) {
    throw new ImportError(`EPUB повреждён: нет файла описания книги ${opfPath}.`);
  }
  const pkg = parseXml(opfXml, opfPath)?.package;
  if (!pkg?.manifest || !pkg?.spine) {
    throw new ImportError(`EPUB повреждён: в ${opfPath} нет списка файлов или порядка чтения.`);
  }

  const metadata = readMetadata(pkg.metadata);
  const opfDir = path.posix.dirname(opfPath);

  const manifest = new Map();
  for (const item of pkg.manifest.item ?? []) {
    if (item['@_id']) manifest.set(item['@_id'], item);
  }

  const documents = [];
  for (const itemref of pkg.spine.itemref ?? []) {
    const item = manifest.get(itemref['@_idref']);
    if (!item) {
      throw new ImportError(`EPUB повреждён: в порядке чтения есть «${itemref['@_idref']}», которого нет в списке файлов.`);
    }
    // Картинка или SVG прямо в spine (обычно обложка) — не текст, пропускаем.
    if (!HTML_MEDIA_TYPES.has(item['@_media-type'])) continue;
    const href = resolveHref(opfDir, item['@_href']);
    const html = await readText(zip, href);
    if (html === null) {
      throw new ImportError(`EPUB повреждён: в архиве нет файла главы ${href}.`);
    }
    documents.push({ href, html });
  }

  return { metadata, documents };
}

async function readText(zip, name) {
  const file = zip.file(name);
  if (!file) return null;
  try {
    return await file.async('string');
  } catch (cause) {
    throw new ImportError(`EPUB повреждён: не удалось распаковать ${name}.`, { cause });
  }
}

function parseXml(xml, name) {
  try {
    return xmlParser.parse(xml);
  } catch (cause) {
    throw new ImportError(`EPUB повреждён: не удалось прочитать ${name}.`, { cause });
  }
}

function readMetadata(meta = {}) {
  const texts = (values) => (values ?? []).map(textOf).filter(Boolean);
  return {
    title: texts(meta.title)[0] ?? '',
    authors: texts(meta.creator),
    language: texts(meta.language)[0] ?? '',
  };
}

function textOf(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && '#text' in value) return String(value['#text']).trim();
  return '';
}

function resolveHref(baseDir, href = '') {
  const clean = href.split('#')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }
  return path.posix.normalize(path.posix.join(baseDir, decoded));
}

// Собирает маленький PDF из своего текста (pdf-lib, Б-05) — тексты книг в репо не кладутся.
// Кириллица — только со своим шрифтом TTF (fontFile); без него — стандартный Helvetica, латиница.
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const PAGE = { width: 400, height: 500 };
const LEFT = 50;
const INDENT = 70;
const TOP = 450;
const LEADING = 1.4;

/**
 * Строка страницы: текст, отступ первой строки абзаца, лишний промежуток перед строкой, размер шрифта.
 * @typedef {{text: string, indent?: boolean, gap?: number, size?: number}} Row
 * Закладка: страница и строка (с 0), на верх которой она указывает; без line — страница целиком.
 * name — назначение именованное (через /Names), а не явное.
 * @typedef {{title: string, page: number, line?: number, name?: string, children?: Bookmark[]}} Bookmark
 *
 * @param {object} book
 * @param {Row[][]} book.pages строки по страницам; пустой массив — страница без текста
 * @param {Bookmark[]} [book.bookmarks]
 * @param {string} [book.title]
 * @param {string} [book.author]
 * @param {string} [book.fontFile] путь к TTF
 * @returns {Promise<Uint8Array>}
 */
export async function buildPdf({ pages, bookmarks = [], title, author, fontFile }) {
  const doc = await PDFDocument.create();
  let font;
  if (fontFile) {
    doc.registerFontkit(fontkit);
    font = await doc.embedFont(await readFile(fontFile), { subset: true });
  } else {
    font = await doc.embedFont(StandardFonts.Helvetica);
  }
  if (title) doc.setTitle(title);
  if (author) doc.setAuthor(author);

  const tops = pages.map((rows) => {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    let y = TOP;
    return rows.map(({ text, indent = false, gap = 0, size = 12 }, index) => {
      const top = index === 0 ? y : y - gap;
      y = top - size;
      page.drawText(text, { x: indent ? INDENT : LEFT, y, size, font });
      y -= size * (LEADING - 1);
      return top;
    });
  });
  if (bookmarks.length > 0) addOutline(doc, bookmarks, tops);
  return doc.save();
}

function addOutline(doc, bookmarks, tops) {
  const { context, catalog } = doc;
  const pageRefs = doc.getPages().map((page) => page.ref);
  const named = [];
  const destination = ({ page, line }) => (line === undefined
    ? context.obj([pageRefs[page], PDFName.of('Fit')])
    : context.obj([pageRefs[page], PDFName.of('XYZ'), null, tops[page][line], null]));

  const build = (items, parentRef) => {
    const refs = items.map(() => context.nextRef());
    items.forEach((item, index) => {
      const entries = { Title: PDFHexString.fromText(item.title), Parent: parentRef };
      if (item.name) {
        named.push(PDFString.of(item.name), destination(item));
        entries.Dest = PDFString.of(item.name);
      } else {
        entries.Dest = destination(item);
      }
      if (index > 0) entries.Prev = refs[index - 1];
      if (index < refs.length - 1) entries.Next = refs[index + 1];
      const children = item.children ?? [];
      if (children.length > 0) {
        const kids = build(children, refs[index]);
        entries.First = kids[0];
        entries.Last = kids[kids.length - 1];
        entries.Count = children.length;
      }
      context.assign(refs[index], context.obj(entries));
    });
    return refs;
  };

  const rootRef = context.nextRef();
  const top = build(bookmarks, rootRef);
  context.assign(rootRef, context.obj({
    Type: PDFName.of('Outlines'), First: top[0], Last: top[top.length - 1], Count: top.length,
  }));
  catalog.set(PDFName.of('Outlines'), rootRef);
  if (named.length > 0) {
    catalog.set(PDFName.of('Names'), context.obj({ Dests: context.obj({ Names: context.obj(named) }) }));
  }
}

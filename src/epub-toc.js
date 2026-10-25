// Главы и подглавы EPUB по вложенности оглавления книги (Б-11): часть книги — пункт
// оглавления, чьи вложенные пункты ведут в другие файлы, — одна глава, а файлы её
// пунктов — подглавы. Пункты над частями (тома) — в начале названия главы, кроме
// обёртки над всей книгой. Таких пунктов нет — главы по файлам, как без оглавления.
//
// Виды пунктов (снизу вверх):
// - группа — есть вложенный пункт на другой файл, и ни один вложенный — не группа и не том;
// - том — среди вложенных есть группа или том;
// - обёртка — том, единственный на верхнем уровне среди групп и томов (полутитул над всеми частями);
// - остальные — как без оглавления.
import { joinChapter, splitDocument } from './chapters.js';
import { plain } from './footnotes.js';

// Причина в «Пропущено» для страницы с одним заголовком части или тома.
export const HEADING_REASON = 'заголовок части — в названии главы';
export const ORDER_WARNING = 'оглавление EPUB не совпадает с порядком чтения — главы по файлам';
const TITLE_JOIN = '. ';

/**
 * @param {import('./epub.js').TocItem[]} toc оглавление книги
 * @param {{href: string, linear: boolean, blocks: import('./chapters.js').Block[], notes?: string[]}[]} docs
 *   документы, ставшие бы главами, в порядке чтения: служебные и пустые уже отложены
 * @returns {null | {warning: string} | {chapters: import('./chapters.js').Chapter[],
 *   skipped: {doc: object, reason: string}[]}}
 *   null — групп нет, главы по файлам; warning — оглавление расходится с порядком чтения
 */
export function chaptersByToc(toc, docs) {
  // Файл пункта — только документ, который стал бы главой: вне spine, linear="no",
  // служебный или пустой — как будто ссылки нет.
  const position = new Map();
  docs.forEach((doc, index) => {
    if (doc.linear && !position.has(doc.href)) position.set(doc.href, index);
  });
  const nodes = annotate(toc, position);
  const top = nodes.filter((node) => node.kind !== 'other');
  if (top.length === 1 && top[0].kind === 'volume') top[0].kind = 'wrapper';

  const groups = [];
  const volumes = new Map();
  const itemFiles = new Set();
  const walk = (list, chain) => {
    for (const node of list) {
      if (node.file !== null) itemFiles.add(node.file);
      if (node.kind === 'group') groups.push({ node, title: [...chain, node].map((item) => item.title).filter(Boolean).join(TITLE_JOIN) });
      if (node.kind === 'volume' && node.file !== null && !volumes.has(node.file)) volumes.set(node.file, node);
      walk(node.children, node.kind === 'volume' ? [...chain, node] : chain);
    }
  };
  walk(nodes, []);
  if (groups.length === 0) return null;

  // Какому файлу какая роль: свой файл группы, он же первая подглава или файл подглавы.
  const claims = new Map();
  let conflict = false;
  for (const group of groups) {
    const { node } = group;
    const files = new Map();
    for (const child of node.children) {
      if (child.file !== null && !files.has(child.file)) files.set(child.file, child.title);
    }
    if (node.file !== null && !files.has(node.file)) files.set(node.file, null);
    for (const [file, title] of files) {
      if (claims.has(file)) conflict = true;
      const role = file !== node.file ? 'member' : title === null ? 'own' : 'self';
      claims.set(file, { group, role, title: role === 'own' ? node.title : title });
    }
    const at = [...files.keys()].map((file) => position.get(file));
    group.first = Math.min(...at);
    group.last = Math.max(...at);
  }
  // Между файлами группы — только её файлы и файлы без пунктов оглавления.
  for (const group of groups) {
    for (let index = group.first + 1; index < group.last; index += 1) {
      const href = docs[index].href;
      if (claims.get(href)?.group !== group && itemFiles.has(href)) conflict = true;
    }
  }
  if (conflict) return { warning: ORDER_WARNING };

  const out = [];
  const skipped = [];
  const built = new Map();
  const sectionsOf = (group) => {
    if (!built.has(group)) {
      const sections = [];
      built.set(group, sections);
      out.push({ group, sections });
    }
    return built.get(group);
  };
  docs.forEach((doc, index) => {
    const claim = claims.get(doc.href);
    const inside = groups.find((group) => index > group.first && index < group.last);
    if (claim?.role === 'member') {
      sectionsOf(claim.group).push({ kind: 'section', title: claim.title, documents: [doc] });
    } else if (claim?.role === 'self') {
      const blocks = withoutFirstHeading(doc.blocks);
      if (isHeadingOnly(blocks, '')) {
        sectionsOf(claim.group);
        skipped.push({ doc, reason: HEADING_REASON });
      } else {
        sectionsOf(claim.group).push({ kind: 'section', title: claim.title, fixed: true, documents: [{ ...doc, blocks }] });
      }
    } else if (claim?.role === 'own') {
      const sections = sectionsOf(claim.group);
      if (isHeadingOnly(doc.blocks, claim.title)) skipped.push({ doc, reason: HEADING_REASON });
      else sections.push({ kind: 'intro', title: claim.title, documents: [{ ...doc, blocks: withoutLeadHeading(doc.blocks) }] });
    } else if (volumes.has(doc.href) && isHeadingOnly(doc.blocks, volumes.get(doc.href).title)) {
      skipped.push({ doc, reason: HEADING_REASON });
    } else if (inside && !itemFiles.has(doc.href)) {
      // Файл без пункта внутри группы (Calibre режет длинные главы) — продолжение предыдущей части.
      const sections = sectionsOf(inside);
      const last = sections.at(-1);
      if (last) last.documents.push(doc);
      else sections.push({ kind: 'intro', title: inside.node.title, documents: [doc] });
    } else {
      out.push({ chapter: splitDocument(doc) });
    }
  });

  const chapters = out
    .filter((entry) => entry.chapter || entry.sections.length > 0)
    .map((entry) => entry.chapter ?? joinChapter(entry.group.title || entry.sections[0].title, entry.sections))
    .filter(Boolean);
  return { chapters, skipped };
}

// Дерево пунктов с файлом и видом; вид считается снизу вверх.
function annotate(items, position) {
  return items.map((item) => {
    const children = annotate(item.children, position);
    const file = item.href !== null && position.has(item.href) ? item.href : null;
    let kind = 'other';
    if (children.some((child) => child.kind === 'group' || child.kind === 'volume')) kind = 'volume';
    else if (children.some((child) => child.file !== null && child.file !== file)) kind = 'group';
    return { title: item.title, file, kind, children };
  });
}

// Страница «без текста»: кроме заголовков, ничего, или весь остальной текст — в тексте
// пункта оглавления (подзаголовок «1805» при пункте «Part I: 1805»).
function isHeadingOnly(blocks, title) {
  const rest = blocks.filter((block) => block.type !== 'heading').map((block) => plain(block.text)).join(' ');
  return letters(title).includes(letters(rest));
}

function letters(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function withoutFirstHeading(blocks) {
  const at = blocks.findIndex((block) => block.type === 'heading');
  return at === -1 ? blocks : [...blocks.slice(0, at), ...blocks.slice(at + 1)];
}

// Заголовок части в начале её страницы — уже в названии главы.
function withoutLeadHeading(blocks) {
  return blocks[0]?.type === 'heading' ? blocks.slice(1) : blocks;
}

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importEpubData } from '../src/import-epub.js';
import { buildEpub, navDocument, ncxDocument, xhtml } from './helpers/epub-builder.js';

// Главы и подглавы EPUB по вложенности оглавления книги (#34, Б-11): часть книги —
// страница с заголовком, её главы — отдельные файлы. Тексты — свои.

const CLI = fileURLToPath(new URL('../bin/import.js', import.meta.url));
const HEADING = 'заголовок части — в названии главы';
const ORDER = 'оглавление EPUB не совпадает с порядком чтения — главы по файлам';

let tmp;
let count = 0;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'book-agent-toc-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/**
 * @param {object} book
 * @param {{href: string, body: string, linear?: false, type?: string}[]} book.docs в порядке чтения
 * @param {import('./helpers/epub-builder.js').TocEntry[]} [book.toc] без него — оглавления нет
 * @param {'nav' | 'ncx'} [book.as] где оглавление: EPUB 3 nav или EPUB 2 NCX
 */
function epubData({ docs, toc, as = 'nav', title = 'Тестовая книга' }) {
  const items = docs.map((doc, i) => ({
    id: `d${i}`,
    href: doc.href,
    content: doc.type ? xhtml(doc.body).replace('<body>', `<body epub:type="${doc.type}">`) : xhtml(doc.body),
  }));
  const spine = docs.map((doc, i) => (doc.linear === false ? { id: `d${i}`, linear: 'no' } : `d${i}`));
  const book = { title, author: 'Автор', language: 'en', items, spine };
  if (toc && as === 'nav') items.push({ id: 'nav', href: 'nav.xhtml', content: navDocument(toc), properties: 'nav' });
  if (toc && as === 'ncx') {
    items.push({ id: 'ncx', href: 'toc.ncx', content: ncxDocument(toc), mediaType: 'application/x-dtbncx+xml' });
    Object.assign(book, { version: '2.0', toc: 'ncx' });
  }
  return buildEpub(book);
}

async function readOut(out) {
  const index = await readFile(path.join(out, 'book.md'), 'utf8');
  const parts = {};
  for (const name of (await readdir(path.join(out, 'parts'))).sort()) {
    parts[name.replace(/\.md$/, '')] = await readFile(path.join(out, 'parts', name), 'utf8');
  }
  const start = index.indexOf('## Пропущено');
  const skipped = start === -1 ? []
    : index.slice(start).split('\n').filter((line) => line.startsWith('| ')).slice(2);
  const toc = index.slice(index.indexOf('## Оглавление')).split('## Пропущено')[0];
  const titles = toc.split('\n').filter((line) => /^\| \d/.test(line)).map((line) => line.split(' | ').slice(0, 2).join(' | '));
  return { index, parts, skipped, titles };
}

async function importBook(book, options = {}) {
  const out = path.join(tmp, `book-${count++}`);
  const { warnings } = await importEpubData(await epubData(book), out, options);
  return { ...(await readOut(out)), warnings, out };
}

function runCli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

const doc = (href, body, extra = {}) => ({ href, body, ...extra });

// Как у Standard Ebooks: предисловие, страницы частей с одним заголовком, главы — файлами.
const PARTS_DOCS = [
  doc('preface.xhtml', '<h2>Preface</h2><p>Before the story begins.</p>'),
  doc('part-1.xhtml', '<h2>Part One</h2>'),
  doc('ch-1-1.xhtml', '<h2>Chapter 1</h2><p>The first chapter.</p>'),
  doc('ch-1-2.xhtml', '<h2>Chapter 2</h2><p>Second.</p><h3>A scene</h3><p>Scene one.</p><h3>Another scene</h3><p>Scene two.</p>'),
  doc('part-2.xhtml', '<h2>Part Two</h2>'),
  doc('ch-2-1.xhtml', '<h2>Chapter 3</h2><p>The third chapter.</p>'),
];
const PARTS_TOC = [
  { title: 'Preface', href: 'preface.xhtml' },
  { title: 'Part One', href: 'part-1.xhtml', children: [
    { title: 'Chapter 1', href: 'ch-1-1.xhtml' },
    { title: 'Chapter 2', href: 'ch-1-2.xhtml' },
  ] },
  { title: 'Part Two', href: 'part-2.xhtml', children: [{ title: 'Chapter 3', href: 'ch-2-1.xhtml' }] },
];

function assertPartsBook({ parts, titles, skipped, warnings, index }) {
  assert.deepEqual(Object.keys(parts), ['001', '002-01', '002-02', '003-01']);
  assert.deepEqual(titles, [
    '| 001 | Preface', '| 002 | Part One', '| 002-01 | Chapter 1', '| 002-02 | Chapter 2',
    '| 003 | Part Two', '| 003-01 | Chapter 3',
  ]);
  assert.equal(parts['001'], '# Preface\n\nBefore the story begins.\n');
  assert.equal(parts['002-01'], '# Part One\n\n## Chapter 1\n\nThe first chapter.\n');
  assert.equal(parts['002-02'], '## Chapter 2\n\nSecond.\n\n### A scene\n\nScene one.\n\n### Another scene\n\nScene two.\n');
  assert.equal(parts['003-01'], '# Part Two\n\n## Chapter 3\n\nThe third chapter.\n');
  assert.deepEqual(skipped, [
    `| OEBPS/part-1.xhtml | Part One | ${HEADING} |`,
    `| OEBPS/part-2.xhtml | Part Two | ${HEADING} |`,
  ]);
  assert.match(index, /^- Глав: 3\n- Частей: 4$/m);
  assert.deepEqual(warnings, []);
}

test('EPUB 3: части книги — главы, файлы глав — подглавы, страницы частей — в «Пропущено»', async () => {
  assertPartsBook(await importBook({ docs: PARTS_DOCS, toc: PARTS_TOC }));
});

test('EPUB 2: то же по NCX (spine@toc → navMap)', async () => {
  assertPartsBook(await importBook({ docs: PARTS_DOCS, toc: PARTS_TOC, as: 'ncx' }));
});

test('тома: название главы — том и часть через «. », страница тома — в «Пропущено»; эпилог с якорями — глава без тома', async () => {
  const { parts, titles, skipped } = await importBook({
    docs: [
      doc('vol-1.xhtml', '<h1>Volume One</h1>'),
      doc('part-1.xhtml', '<h2>Part One</h2>'),
      doc('ch-1.xhtml', '<h3>Chapter 1</h3><p>One.</p>'),
      doc('part-2.xhtml', '<h2>Part Two</h2>'),
      doc('ch-2.xhtml', '<h3>Chapter 2</h3><p>Two.</p>'),
      doc('vol-2.xhtml', '<h1>Volume Two</h1><p>Written later, in another city.</p>'),
      doc('ch-3.xhtml', '<h3>Chapter 3</h3><p>Three.</p>'),
      doc('epilogue.xhtml', '<h2>Epilogue</h2><p id="e1">The end.</p>'),
    ],
    toc: [
      { title: 'Volume One', href: 'vol-1.xhtml', children: [
        { title: 'Part One', href: 'part-1.xhtml', children: [{ title: 'Chapter 1', href: 'ch-1.xhtml' }] },
        { title: 'Part Two', href: 'part-2.xhtml', children: [{ title: 'Chapter 2', href: 'ch-2.xhtml' }] },
      ] },
      { title: 'Volume Two', href: 'vol-2.xhtml', children: [
        { title: 'Part Three', children: [{ title: 'Chapter 3', href: 'ch-3.xhtml' }] },
        { title: 'Epilogue', href: 'epilogue.xhtml', children: [{ title: 'The end', href: 'epilogue.xhtml#e1' }] },
      ] },
    ],
  });
  assert.deepEqual(titles, [
    '| 001 | Volume One. Part One', '| 001-01 | Chapter 1',
    '| 002 | Volume One. Part Two', '| 002-01 | Chapter 2',
    '| 003 | Volume Two',
    '| 004 | Volume Two. Part Three', '| 004-01 | Chapter 3',
    '| 005 | Epilogue',
  ]);
  assert.equal(parts['001-01'], '# Volume One. Part One\n\n## Chapter 1\n\nOne.\n');
  assert.equal(parts['003'], '# Volume Two\n\nWritten later, in another city.\n');
  assert.equal(parts['004-01'], '# Volume Two. Part Three\n\n## Chapter 3\n\nThree.\n');
  assert.deepEqual(skipped, [
    `| OEBPS/vol-1.xhtml | Volume One | ${HEADING} |`,
    `| OEBPS/part-1.xhtml | Part One | ${HEADING} |`,
    `| OEBPS/part-2.xhtml | Part Two | ${HEADING} |`,
  ]);
});

test('обёртка над всеми частями (без файла или на полутитул) — названий не меняет', async () => {
  const parts = [
    { title: 'Part One', href: 'part-1.xhtml', children: [{ title: 'Chapter 1', href: 'ch-1-1.xhtml' }, { title: 'Chapter 2', href: 'ch-1-2.xhtml' }] },
    { title: 'Part Two', href: 'part-2.xhtml', children: [{ title: 'Chapter 3', href: 'ch-2-1.xhtml' }] },
  ];
  const halftitle = doc('halftitle.xhtml', '<h1>Book Title</h1>');
  for (const [name, docs, wrapper] of [
    ['без файла', PARTS_DOCS, { title: 'Book Title', children: parts }],
    ['на полутитул', [halftitle, ...PARTS_DOCS], { title: 'Book Title', href: 'halftitle.xhtml', children: parts }],
  ]) {
    const book = await importBook({ title: 'Book Title', docs, toc: [{ title: 'Preface', href: 'preface.xhtml' }, wrapper] });
    assert.deepEqual(book.titles, [
      '| 001 | Preface', '| 002 | Part One', '| 002-01 | Chapter 1', '| 002-02 | Chapter 2',
      '| 003 | Part Two', '| 003-01 | Chapter 3',
    ], name);
    assert.equal(book.parts['002-01'], '# Part One\n\n## Chapter 1\n\nThe first chapter.\n', name);
  }
});

test('подзаголовок части в hgroup при пункте «Part I: 1805» — страница в «Пропущено», название по пункту', async () => {
  const { parts, titles, skipped } = await importBook({
    docs: [
      doc('part-1.xhtml', '<hgroup><h3>Part I</h3><p>1805</p></hgroup>'),
      doc('ch-1.xhtml', '<h3>I</h3><p>Evening in a salon.</p>'),
    ],
    toc: [{ title: 'Part I: 1805', href: 'part-1.xhtml', children: [{ title: 'I', href: 'ch-1.xhtml' }] }],
  });
  assert.deepEqual(titles, ['| 001 | Part I: 1805', '| 001-01 | I']);
  assert.equal(parts['001-01'], '# Part I: 1805\n\n## I\n\nEvening in a salon.\n');
  assert.deepEqual(skipped, [`| OEBPS/part-1.xhtml | Part I | ${HEADING} |`]);
});

test('первый вложенный пункт — на файл самой части (как у Gutenberg): файл части — подглава 01', async () => {
  const { parts, titles, skipped } = await importBook({
    docs: [
      doc('part-1.xhtml', '<h2>Book One</h2><h3 id="ch1">Chapter I. Arrival</h3><p>They arrived at dawn.</p>'),
      doc('ch-2.xhtml', '<h3>Chapter II</h3><p>Next day.</p>'),
    ],
    toc: [{ title: 'Book One', href: 'part-1.xhtml', children: [
      { title: 'Chapter I', href: 'part-1.xhtml#ch1' },
      { title: 'Chapter II', href: 'ch-2.xhtml' },
    ] }],
  });
  assert.deepEqual(titles, ['| 001 | Book One', '| 001-01 | Chapter I', '| 001-02 | Chapter II']);
  assert.equal(parts['001-01'], '# Book One\n\n## Chapter I. Arrival\n\nThey arrived at dawn.\n');
  assert.equal(parts['001-02'], '## Chapter II\n\nNext day.\n');
  assert.deepEqual(skipped, []);
});

test('страница части с текстом — NNN-00 «Начало главы»', async () => {
  const { parts, titles, skipped } = await importBook({
    docs: [
      doc('part-1.xhtml', '<h2>Part One</h2><p>An epigraph for the whole part.</p>'),
      doc('ch-1.xhtml', '<h2>Chapter 1</h2><p>One.</p>'),
    ],
    toc: [{ title: 'Part One', href: 'part-1.xhtml', children: [{ title: 'Chapter 1', href: 'ch-1.xhtml' }] }],
  });
  assert.deepEqual(titles, ['| 001 | Part One', '| 001-00 | Начало главы', '| 001-01 | Chapter 1']);
  assert.equal(parts['001-00'], '# Part One\n\nAn epigraph for the whole part.\n');
  assert.equal(parts['001-01'], '## Chapter 1\n\nOne.\n');
  assert.deepEqual(skipped, []);
});

test('файл без пункта между подглавами — продолжение предыдущей; после последней подглавы — отдельная глава', async () => {
  const { parts, titles } = await importBook({
    docs: [
      doc('part-1.xhtml', '<h2>Part One</h2>'),
      doc('ch-1.xhtml', '<h2>Chapter 1</h2><p>Start of a long chapter.</p>'),
      doc('ch-1-split.xhtml', '<p>Its continuation.</p><h2>Inside</h2><p>More.</p>'),
      doc('ch-2.xhtml', '<h2>Chapter 2</h2><p>Second.</p>'),
      doc('ch-2-split.xhtml', '<p>Tail of the last chapter.</p>'),
    ],
    toc: [{ title: 'Part One', href: 'part-1.xhtml', children: [
      { title: 'Chapter 1', href: 'ch-1.xhtml' },
      { title: 'Chapter 2', href: 'ch-2.xhtml' },
    ] }],
  });
  assert.deepEqual(titles, ['| 001 | Part One', '| 001-01 | Chapter 1', '| 001-02 | Chapter 2', '| 002 | Tail of the last chapter.']);
  assert.equal(parts['001-01'], '# Part One\n\n## Chapter 1\n\nStart of a long chapter.\n\nIts continuation.\n\n### Inside\n\nMore.\n');
  assert.equal(parts['002'], 'Tail of the last chapter.\n');
});

test('страница части — служебная по разметке: название главы по пункту', async () => {
  const { parts, titles, skipped } = await importBook({
    docs: [
      doc('part-1.xhtml', '<p>Part One page</p>', { type: 'titlepage' }),
      doc('ch-1.xhtml', '<h2>Chapter 1</h2><p>One.</p>'),
      doc('ch-2.xhtml', '<h2>Chapter 2</h2><p>Two.</p>'),
    ],
    toc: [{ title: 'Part One', href: 'part-1.xhtml', children: [
      { title: 'Chapter 1', href: 'ch-1.xhtml' },
      { title: 'Chapter 2', href: 'ch-2.xhtml' },
    ] }],
  });
  assert.deepEqual(titles, ['| 001 | Part One', '| 001-01 | Chapter 1', '| 001-02 | Chapter 2']);
  assert.equal(parts['001-01'], '# Part One\n\n## Chapter 1\n\nOne.\n');
  assert.deepEqual(skipped, ['| OEBPS/part-1.xhtml | Part One page | разметка: titlepage |']);
});

test('пункт на файл linear="no" — как без ссылки: группы нет, главы по файлам', async () => {
  const docs = [
    doc('ch-1.xhtml', '<h2>Chapter 1</h2><p>One.</p>'),
    doc('note.xhtml', '<h2>A note</h2><p>Aside.</p>', { linear: false }),
  ];
  const { titles, parts } = await importBook({
    docs,
    toc: [{ title: 'Chapter 1', href: 'ch-1.xhtml', children: [{ title: 'A note', href: 'note.xhtml' }] }],
  });
  assert.deepEqual(titles, ['| 001 | Chapter 1', '| 002 | A note']);
  assert.deepEqual(parts, (await importBook({ docs })).parts);
});

test('--all: страница части по-прежнему в «Пропущено» с новой причиной', async () => {
  const { skipped, titles } = await importBook({ docs: PARTS_DOCS, toc: PARTS_TOC }, { all: true });
  assert.deepEqual(skipped, [
    `| OEBPS/part-1.xhtml | Part One | ${HEADING} |`,
    `| OEBPS/part-2.xhtml | Part Two | ${HEADING} |`,
  ]);
  assert.equal(titles.length, 6);
});

test('--append после книги с частями — следующий номер главы', async () => {
  const input = path.join(tmp, 'parts.epub');
  await writeFile(input, await epubData({ docs: PARTS_DOCS, toc: PARTS_TOC }));
  const out = path.join(tmp, 'parts-append');
  assert.equal(runCli(input, out).status, 0);
  const piece = path.join(tmp, 'piece.txt');
  await writeFile(piece, '# Afterword\n\nA few words later.\n');
  const result = runCli('--append', piece, out);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /часть 004/);
  const { parts, titles } = await readOut(out);
  assert.equal(parts['004'], '# Afterword\n\nA few words later.\n');
  assert.equal(titles.at(-1), '| 004 | Afterword');
});

test('плоское оглавление, оглавление из якорей и без оглавления — вывод побайтно как без него', async () => {
  const docs = [
    doc('c1.xhtml', '<h1>One</h1><p>Intro.</p><h2 id="s1">First</h2><p>A.</p><h2 id="s2">Second</h2><p>B.</p>'),
    doc('c2.xhtml', '<h1>Two</h1><p>C.</p>'),
  ];
  const plain = await importBook({ docs });
  const flat = await importBook({ docs, toc: [{ title: 'One', href: 'c1.xhtml' }, { title: 'Two', href: 'c2.xhtml' }] });
  const anchors = await importBook({ docs, toc: [
    { title: 'One', href: 'c1.xhtml', children: [{ title: 'First', href: 'c1.xhtml#s1' }, { title: 'Second', href: 'c1.xhtml#s2' }] },
    { title: 'Two', href: 'c2.xhtml' },
  ] });
  const ncx = await importBook({ docs, as: 'ncx', toc: [{ title: 'One', href: 'c1.xhtml' }, { title: 'Two', href: 'c2.xhtml' }] });
  assert.deepEqual(Object.keys(plain.parts), ['001-00', '001-01', '001-02', '002']);
  for (const [name, book] of [['плоское', flat], ['якоря', anchors], ['NCX', ncx]]) {
    assert.equal(book.index, plain.index, name);
    assert.deepEqual(book.parts, plain.parts, name);
    assert.deepEqual(book.warnings, [], name);
  }
});

test('подглава одной части стоит в spine внутри другой — предупреждение, главы по файлам', async () => {
  const docs = [
    doc('part-1.xhtml', '<h2>Part One</h2>'),
    doc('ch-1-1.xhtml', '<h2>Chapter 1</h2><p>One.</p>'),
    doc('ch-2-1.xhtml', '<h2>Chapter 3</h2><p>Three.</p>'),
    doc('ch-1-2.xhtml', '<h2>Chapter 2</h2><p>Two.</p>'),
  ];
  const toc = [
    { title: 'Part One', href: 'part-1.xhtml', children: [{ title: 'Chapter 1', href: 'ch-1-1.xhtml' }, { title: 'Chapter 2', href: 'ch-1-2.xhtml' }] },
    { title: 'Part Two', children: [{ title: 'Chapter 3', href: 'ch-2-1.xhtml' }] },
  ];
  const book = await importBook({ docs, toc });
  assert.deepEqual(book.warnings, [ORDER]);
  assert.deepEqual(book.titles, ['| 001 | Part One', '| 002 | Chapter 1', '| 003 | Chapter 3', '| 004 | Chapter 2']);
  assert.equal(book.index, (await importBook({ docs })).index);

  const input = path.join(tmp, 'order.epub');
  await writeFile(input, await epubData({ docs, toc }));
  const result = runCli(input, path.join(tmp, 'order'));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`^Предупреждение: ${ORDER}$`, 'm'));
});

test('сноски в подглавах — нумерация своя в каждой части, продолжение — тем же рядом; файл примечаний — в «Пропущено»', async () => {
  const note = (id) => `<sup><a href="notes.xhtml#n${id}" id="r${id}">${id}</a></sup>`;
  const { parts, skipped, index } = await importBook({
    docs: [
      doc('part-1.xhtml', '<h2>Part One</h2>'),
      doc('ch-1.xhtml', `<h2>Chapter 1</h2><p>Word${note(1)} here.</p>`),
      doc('ch-2.xhtml', `<h2>Chapter 2</h2><p>Other${note(2)} word.</p>`),
      doc('ch-2-split.xhtml', `<p>Continued${note(3)} text.</p>`),
      doc('ch-3.xhtml', `<h2>Chapter 3</h2><p>Last.</p>`),
      doc('notes.xhtml', `<h1>Notes</h1>
        <p id="n1"><a href="ch-1.xhtml#r1">1</a> First note.</p>
        <p id="n2"><a href="ch-2.xhtml#r2">2</a> Second note.</p>
        <p id="n3"><a href="ch-2-split.xhtml#r3">3</a> Third note.</p>`),
    ],
    toc: [{ title: 'Part One', href: 'part-1.xhtml', children: [
      { title: 'Chapter 1', href: 'ch-1.xhtml' },
      { title: 'Chapter 2', href: 'ch-2.xhtml' },
      { title: 'Chapter 3', href: 'ch-3.xhtml' },
    ] }],
  });
  assert.equal(parts['001-01'], '# Part One\n\n## Chapter 1\n\nWord[^1] here.\n\n[^1]: First note.\n');
  assert.equal(parts['001-02'], '## Chapter 2\n\nOther[^1] word.\n\nContinued[^2] text.\n\n[^1]: Second note.\n[^2]: Third note.\n');
  assert.equal(parts['001-03'], '## Chapter 3\n\nLast.\n');
  assert.match(index, /^- Сносок: 3$/m);
  assert.deepEqual(skipped, [
    `| OEBPS/part-1.xhtml | Part One | ${HEADING} |`,
    '| OEBPS/notes.xhtml | Notes | примечания — разнесены по частям |',
  ]);
});

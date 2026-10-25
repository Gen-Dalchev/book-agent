import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEpub, xhtml } from './helpers/epub-builder.js';
import { htmlToBlocks } from '../src/html-to-blocks.js';
import { buildChapters, splitDocument } from '../src/chapters.js';
import { planBook } from '../src/layout.js';
import { splitBlocks } from '../src/refs.js';
import { countNoteDefinitions } from '../src/footnotes.js';

// Сноски внутри главы (Б-07): `слово[^1]` в абзаце, `[^1]: текст` в конце части.

const IMPORT = fileURLToPath(new URL('../bin/import.js', import.meta.url));
const SHOW = fileURLToPath(new URL('../bin/show.js', import.meta.url));

const parts = (body, href) => splitDocument(htmlToBlocks(`<html><body>${body}</body></html>`, { href })).parts;
const part = (body, href) => parts(body, href)[0].markdown;

test('EPUB 3: noteref и aside — метка в абзаце, текст в конце части', () => {
  assert.equal(part(`
    <h1>Глава</h1>
    <p>Слово<a epub:type="noteref" href="#n1">1</a> и дальше.</p>
    <aside epub:type="footnote" id="n1"><p>1 Текст сноски.</p></aside>
    <p>Последний абзац.</p>`),
  '# Глава\n\nСлово[^1] и дальше.\n\nПоследний абзац.\n\n[^1]: Текст сноски.\n');
});

test('без epub:type, три формы: обратная ссылка — не сноска, абзац главы на месте, знак снят', () => {
  const expected = 'Слово[^1] и дальше.\n\nКонец главы.\n\n[^1]: Текст примечания.\n';
  // (а) id у самой ссылки, в примечании — ссылка назад в <sup>.
  assert.equal(part(`
    <p>Слово<sup><a href="#n1" id="r1">1</a></sup> и дальше.</p>
    <p>Конец главы.</p>
    <p id="n1"><sup><a href="#r1">1</a></sup> Текст примечания.</p>`), expected);
  // (б) id у <sup> вокруг ссылки.
  assert.equal(part(`
    <p>Слово<sup id="r1"><a href="#n1">1</a></sup> и дальше.</p>
    <p>Конец главы.</p>
    <p id="n1"><sup><a href="#r1">1</a></sup> Текст примечания.</p>`), expected);
  // (в) цель — пустой <a name> в начале абзаца примечания, знак в скобках.
  assert.equal(part(`
    <p>Слово<sup><a href="#n1" id="r1">[1]</a></sup> и дальше.</p>
    <p>Конец главы.</p>
    <p><a name="n1"></a>[1] Текст примечания.</p>`), expected);
});

test('знак сноски «*», ведущий знак «1.» и «1)»', () => {
  assert.equal(part(`
    <p>Звезда<sup><a href="#s">*</a></sup>, раз<sup><a href="#a">1</a></sup>, два<sup><a href="#b">2</a></sup>.</p>
    <p id="s">* Пояснение.</p>
    <p id="a">1. Первое.</p>
    <p id="b">2) Второе.</p>`),
  'Звезда[^1], раз[^2], два[^3].\n\n[^1]: Пояснение.\n[^2]: Первое.\n[^3]: Второе.\n');
});

test('одна цель — две ссылки в части: одна метка; список примечаний вырезан целиком', () => {
  assert.equal(part(`
    <p>Раз<sup><a href="#n">1</a></sup>, два&#160;<sup><a href="#n">1</a></sup>.</p>
    <p>Ещё <sup><a href="#m">2</a></sup>.</p>
    <ol><li id="n">Первое.</li><li id="m">Второе.</li></ol>`),
  'Раз[^1], два[^1].\n\nЕщё[^2].\n\n[^1]: Первое.\n[^2]: Второе.\n');
});

test('одна цель — ссылки из двух частей: в каждой своя метка и своё определение', () => {
  const result = parts(`
    <h1>Глава</h1>
    <h2>Первая</h2><p>Раз<sup><a href="#n">1</a></sup>.</p>
    <h2>Вторая</h2><p>Два<sup><a href="#m">2</a></sup>, три<sup><a href="#n">1</a></sup>.</p>
    <div class="notes"><p id="n">Общее.</p><p id="m">Своё.</p></div>`);
  assert.deepEqual(result.map((p) => p.markdown), [
    '# Глава\n\n## Первая\n\nРаз[^1].\n\n[^1]: Общее.\n',
    '## Вторая\n\nДва[^1], три[^2].\n\n[^1]: Своё.\n[^2]: Общее.\n',
  ]);
});

test('висячая ссылка и ссылка на раздел с заголовком — не сноски, всё как раньше', () => {
  assert.equal(part(`
    <p>Висит<sup><a href="#nope">1</a></sup>, см. раздел<sup><a href="#sec3">3</a></sup>.</p>
    <section id="sec3"><h2>Третий</h2><p>Текст раздела.</p></section>`),
  'Висит1, см. раздел3.\n\n## Третий\n\nТекст раздела.\n');
});

test('ссылка «этот-файл.xhtml#id» — сноска, на другой файл — нет', () => {
  assert.equal(part(`
    <p>Сюда<sup><a href="a.xhtml#n">1</a></sup>, туда<sup><a href="b.xhtml#n">2</a></sup>.</p>
    <p id="n">Здешнее.</p>`, 'OEBPS/text/a.xhtml'),
  'Сюда[^1], туда2.\n\n[^1]: Здешнее.\n');
});

test('сноска в заголовке: в части метка есть, в book.md — нет', () => {
  const chapters = buildChapters([
    htmlToBlocks(`<body>
      <h1>Глава 1<sup><a href="#t">1</a></sup></h1>
      <h2>Раз<sup><a href="#u">2</a></sup></h2><p>Текст.</p>
      <h2>Два</h2><p>Ещё.</p>
      <p id="t">О заглавии.</p><p id="u">О подглаве.</p></body>`),
  ]);
  assert.equal(chapters[0].parts[0].markdown, '# Глава 1[^1]\n\n## Раз[^2]\n\nТекст.\n\n[^1]: О заглавии.\n[^2]: О подглаве.\n');
  const plan = planBook({ metadata: { title: 'К', authors: [], language: '' }, chapters });
  const index = plan.files[0].content;
  assert.match(index, /^\| 001 \| Глава 1 \| — \| \d+ \|$/m);
  assert.match(index, /^\| 001-01 \| Раз \| parts\/001-01\.md \| \d+ \|$/m);
  assert.match(index, /^- Сносок: 2$/m);
  assert.doesNotMatch(index, /\[\^/);
});

test('сноска внутри текста сноски не разбирается, её текст остаётся', () => {
  // На второе примечание ведёт только ссылка из первого — оно остаётся текстом.
  assert.equal(part(`
    <p>Текст<sup><a href="#a">1</a></sup>.</p>
    <ol><li id="a">Первое, см. ниже<sup><a href="#b">2</a></sup></li><li id="b">Второе.</li></ol>`),
  'Текст[^1].\n\n1. Второе.\n\n[^1]: Первое, см. ниже2\n');
  // Ведёт и из главы — своя сноска.
  assert.equal(part(`
    <p>Текст<sup><a href="#a">1</a></sup> и ещё<sup><a href="#b">2</a></sup>.</p>
    <ol><li id="a">Первое, см. ниже<sup><a href="#b">2</a></sup></li><li id="b">Второе.</li></ol>`),
  'Текст[^1] и ещё[^2].\n\n[^1]: Первое, см. ниже2\n[^2]: Второе.\n');
});

test('примечание из двух <p> и с <br> — одна строка, курсив сохранён', () => {
  assert.equal(part(`
    <p>Слово<sup><a href="#n">1</a></sup>.</p>
    <aside id="n"><p>1. Первая строка,<br/>вторая.</p>
    <p>Второй <em>абзац</em>.</p></aside>`),
  'Слово[^1].\n\n[^1]: Первая строка, вторая. Второй *абзац*.\n');
});

test('сноска в начале абзаца, на который ведёт ссылка из примечания, — пара остаётся текстом', () => {
  assert.equal(part(`
    <p><sup><a href="#n1" id="r1">1</a></sup> Начало абзаца.</p>
    <p id="n1"><sup><a href="#r1">1</a></sup> Примечание.</p>`),
  '1 Начало абзаца.\n\n1 Примечание.\n');
});

test('примечание без ссылки на него остаётся текстом на месте', () => {
  assert.equal(part(`
    <p>Слово<sup><a href="#a">1</a></sup>.</p>
    <ol><li id="a">Первое.</li><li id="b">Без ссылки.</li></ol>`),
  'Слово[^1].\n\n1. Без ссылки.\n\n[^1]: Первое.\n');
});

test('счёт абзацев: блок определений в конце части — не абзац', () => {
  const markdown = '# Глава\n\nАбзац[^1].\n\n[^1]: Не абзац.\n\nВторой абзац[^2].\n\n[^1]: Раз\n[^2]: Два\n';
  assert.deepEqual(splitBlocks(markdown).map((block) => [block.kind, block.number ?? null]), [
    ['heading', null], ['paragraph', 1], ['paragraph', 2], ['paragraph', 3], ['notes', null],
  ]);
  assert.equal(countNoteDefinitions(markdown), 2);
  assert.equal(countNoteDefinitions('Абзац.\n'), 0);
  assert.equal(countNoteDefinitions('Абзац.\n[^1]: склеено с абзацем\n'), 0);
});

// Глава из Pandoc: сноски в конце главы блоком doc-endnotes, глава режется на подглавы.
const PANDOC = xhtml(`
  <section epub:type="chapter">
    <h1>Глава со сносками</h1>
    <h2>Первая</h2>
    <p>Абзац один<a href="#fn1" id="r1" role="doc-noteref"><sup>1</sup></a>.</p>
    <p>Абзац два.</p>
    <h2>Вторая</h2>
    <p>Абзац три<a href="#fn2" id="r2" role="doc-noteref"><sup>2</sup></a> и&#160;<a href="#fn1" id="r1b" role="doc-noteref"><sup>1</sup></a>.</p>
    <p>Абзац четыре.</p>
    <section role="doc-endnotes" epub:type="endnotes"><hr/><h2>Notes</h2><ol>
      <li id="fn1"><p>Первое примечание. <a href="#r1" role="doc-backlink">↩</a></p></li>
      <li id="fn2"><p>Второе <em>примечание</em>. <a href="#r2" role="doc-backlink">↩</a></p></li>
    </ol></section>
  </section>`, 'Глава со сносками');
const PLAIN = xhtml('<h1>Без сносок</h1><p>Обычный абзац.</p><p>Ещё один.</p>', 'Без сносок');

let tmp;
let book;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'book-agent-notes-'));
  const input = path.join(tmp, 'notes.epub');
  await writeFile(input, await buildEpub({
    title: 'Книга со сносками',
    author: 'Автор',
    language: 'ru',
    items: [
      { id: 'one', href: 'one.xhtml', content: PANDOC },
      { id: 'two', href: 'two.xhtml', content: PLAIN },
    ],
    spine: ['one', 'two'],
  }));
  book = path.join(tmp, 'книга');
  const result = spawnSync(process.execPath, [IMPORT, input, book], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const read = (file) => readFile(path.join(book, file), 'utf8');

function show(...args) {
  const result = spawnSync(process.execPath, [SHOW, book, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('блок doc-endnotes: определения ушли в свои части, ни «Notes», ни ---, ни лишней части', async () => {
  assert.deepEqual((await readdir(path.join(book, 'parts'))).sort(), ['001-01.md', '001-02.md', '002.md']);
  assert.equal(await read('parts/001-01.md'),
    '# Глава со сносками\n\n## Первая\n\nАбзац один[^1].\n\nАбзац два.\n\n[^1]: Первое примечание.\n');
  assert.equal(await read('parts/001-02.md'),
    '## Вторая\n\nАбзац три[^1] и[^2].\n\nАбзац четыре.\n\n[^1]: Второе *примечание*.\n[^2]: Первое примечание.\n');
  assert.equal(await read('parts/002.md'), '# Без сносок\n\nОбычный абзац.\n\nЕщё один.\n');

  const index = await read('book.md');
  assert.match(index, /^- Частей: 3\n- Сносок: 3\n$/m);
  assert.doesNotMatch(index, /Notes|\[\^/);
});

test('show: ¶N у части со сносками — N-й абзац исходника, определения без номера', () => {
  assert.equal(show('001-02', '¶1'), '¶1 Абзац три[^1] и[^2].\n');
  assert.equal(show('001-02', '¶2'), '¶2 Абзац четыре.\n');
  assert.equal(show('001-01', '¶2'), '¶2 Абзац два.\n');
  assert.equal(show('001-02', '¶1–2'), '¶1 Абзац три[^1] и[^2].\n\n¶2 Абзац четыре.\n');
  assert.equal(show('001-02'),
    '## Вторая\n\n¶1 Абзац три[^1] и[^2].\n\n¶2 Абзац четыре.\n\n[^1]: Второе *примечание*.\n[^2]: Первое примечание.\n');

  const result = spawnSync(process.execPath, [SHOW, book, '001-02', '¶3'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /В части 001-02 абзацев: 2, а запрошен ¶3\./);
});

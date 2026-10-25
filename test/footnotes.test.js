import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEpub, xhtml } from './helpers/epub-builder.js';
import { htmlToBlocks } from '../src/html-to-blocks.js';
import { splitDocument } from '../src/chapters.js';
import { planBook } from '../src/layout.js';
import { splitBlocks } from '../src/refs.js';

const IMPORT = fileURLToPath(new URL('../bin/import.js', import.meta.url));
const SHOW = fileURLToPath(new URL('../bin/show.js', import.meta.url));

const doc = (body, href) => splitDocument(htmlToBlocks(`<html><body>${body}</body></html>`, { href }));
const markdown = (body, href) => doc(body, href).parts.map((part) => part.markdown);
const only = (body, href) => {
  const parts = markdown(body, href);
  assert.equal(parts.length, 1);
  return parts[0];
};

test('EPUB 3: noteref и aside — метка в абзаце, определение в конце части', () => {
  assert.equal(only(`
    <h1>Глава</h1>
    <p>Слово<a epub:type="noteref" href="#n1">1</a> дальше.</p>
    <p>Второй абзац.</p>
    <aside epub:type="footnote" id="n1"><p>Текст сноски.</p></aside>`),
  '# Глава\n\nСлово[^1] дальше.\n\nВторой абзац.\n\n[^1]: Текст сноски.\n');
});

test('role="doc-noteref" вместо epub:type; пробелы перед ссылкой, в том числе неразрывные, убираются', () => {
  assert.equal(only(`
    <p>Слово <a role="doc-noteref" href="#n1">примечание</a> и ещё&#160;<a role="doc-noteref" href="#n2">см.</a>.</p>
    <p id="n1">Раз.</p><p id="n2">Два.</p>`),
  'Слово[^1] и ещё[^2].\n\n[^1]: Раз.\n[^2]: Два.\n');
});

test('без epub:type, форма (а): ссылка с id в <sup>, примечание начинается со знака-обратной ссылки', () => {
  assert.equal(only(`
    <h1>Г</h1>
    <p>Начало абзаца слово<sup><a href="#n1" id="r1">1</a></sup> конец.</p>
    <p>Следующий абзац.</p>
    <p id="n1"><sup><a href="#r1">1</a></sup> Текст</p>`),
  '# Г\n\nНачало абзаца слово[^1] конец.\n\nСледующий абзац.\n\n[^1]: Текст\n');
});

test('без epub:type, форма (б): id у <sup>, ссылка внутри него', () => {
  assert.equal(only(`
    <h1>Г</h1>
    <p>Начало абзаца слово<sup id="r1"><a href="#n1">1</a></sup> конец.</p>
    <p>Следующий абзац.</p>
    <p id="n1"><sup><a href="#r1">1</a></sup> Текст</p>`),
  '# Г\n\nНачало абзаца слово[^1] конец.\n\nСледующий абзац.\n\n[^1]: Текст\n');
});

test('без epub:type, форма (в): примечание — <a name> и знак в скобках', () => {
  assert.equal(only(`
    <h1>Г</h1>
    <p>Начало абзаца слово<sup><a href="#n1" id="r1">[1]</a></sup> конец.</p>
    <p>Следующий абзац.</p>
    <p><a name="n1"></a>[1] Текст</p>`),
  '# Г\n\nНачало абзаца слово[^1] конец.\n\nСледующий абзац.\n\n[^1]: Текст\n');
});

test('ведущий знак снимается один раз и только свой: «1.», «1)», «*», «12 апреля»', () => {
  assert.equal(only(`
    <p>А<sup><a href="#a">1</a></sup> Б<sup><a href="#b">1</a></sup> В<sup><a href="#c">1</a></sup>
      Г<sup><a href="#d">*</a></sup> Д<sup><a href="#e">†</a></sup></p>
    <p id="a">1. Точка.</p><p id="b">1) Скобка.</p><p id="c">12 апреля.</p>
    <p id="d">* Звёздочка.</p><p id="e">†† Двойной.</p>`),
  'А[^1] Б[^2] В[^3] Г[^4] Д[^5]\n\n[^1]: Точка.\n[^2]: Скобка.\n[^3]: 12 апреля.\n[^4]: Звёздочка.\n[^5]: † Двойной.\n');
});

test('курсив и жирный в сноске — как в абзацах; два блока и <br> — одна строка', () => {
  assert.equal(only(`
    <p>Текст<sup><a href="#n1">1</a></sup> и<sup><a href="#n2">2</a></sup>.</p>
    <aside id="n1"><p>1 Первый <em>курсив</em> и <strong>жирный</strong>.</p>
      <p>Второй блок.</p></aside>
    <div id="n2">Строка один<br/>строка два<br/><br/>строка три</div>`),
  'Текст[^1] и[^2].\n\n'
    + '[^1]: Первый *курсив* и **жирный**. Второй блок.\n'
    + '[^2]: Строка один строка два строка три\n');
});

test('одна цель — две ссылки в одной части: одна метка и одно определение', () => {
  assert.equal(only(`
    <p>Раз<sup><a href="#n1">1</a></sup>, два<sup><a href="#n2">2</a></sup>, снова<sup><a href="#n1">1</a></sup>.</p>
    <p id="n1">Первая.</p><p id="n2">Вторая.</p>`),
  'Раз[^1], два[^2], снова[^1].\n\n[^1]: Первая.\n[^2]: Вторая.\n');
});

test('метки — по первому появлению сверху вниз, а не по порядку примечаний', () => {
  assert.equal(only(`
    <p>Раз<sup><a href="#b">2</a></sup>, два<sup><a href="#a">1</a></sup>.</p>
    <p id="a">Первая.</p><p id="b">Вторая.</p>`),
  'Раз[^1], два[^2].\n\n[^1]: Вторая.\n[^2]: Первая.\n');
});

test('глава на подглавы: у каждой части свои метки и определения, раздел «Notes» исчез целиком', () => {
  const parts = markdown(`
    <h1>Глава</h1>
    <h2>Первая</h2>
    <p>Раз<sup><a epub:type="noteref" role="doc-noteref" href="#fn1" id="r1">1</a></sup>.</p>
    <h2>Вторая</h2>
    <p>Два<sup><a href="#fn2" id="r2">2</a></sup> и ещё<sup><a href="#fn1" id="r3">1</a></sup>.</p>
    <section role="doc-endnotes"><hr/><h2>Notes</h2><ol>
      <li id="fn1"><p>Первая сноска. <a href="#r1" role="doc-backlink">↩</a></p></li>
      <li id="fn2">Вторая сноска. <a href="#r2" role="doc-backlink">↩</a></li>
    </ol></section>`);
  assert.deepEqual(parts, [
    '# Глава\n\n## Первая\n\nРаз[^1].\n\n[^1]: Первая сноска.\n',
    '## Вторая\n\nДва[^1] и ещё[^2].\n\n[^1]: Вторая сноска.\n[^2]: Первая сноска.\n',
  ]);
});

test('обёртка с примечаниями, в которой остался чужой текст, остаётся', () => {
  assert.equal(only(`
    <h1>Глава</h1>
    <p>Слово<sup><a href="#fn1">1</a></sup>.</p>
    <section><h2>Примечания</h2><ol><li id="fn1">Сноска.</li><li id="fn2">Ничья.</li></ol></section>`),
  '# Глава\n\nСлово[^1].\n\n## Примечания\n\n1. Ничья.\n\n[^1]: Сноска.\n');
});

test('примечание, на которое не ведёт ни одна сноска, остаётся текстом', () => {
  assert.equal(only('<p>Текст.</p><aside id="n1"><p>Ничья заметка.</p></aside>'), 'Текст.\n\nНичья заметка.\n');
});

test('сноска в заголовке: метка в файле части, в оглавлении book.md без неё', () => {
  const chapter = doc(`
    <h1>Глава<sup><a href="#n1">1</a></sup></h1>
    <p>Текст.</p>
    <p id="n1">Про заголовок.</p>`);
  assert.equal(chapter.title, 'Глава');
  assert.equal(chapter.parts[0].markdown, '# Глава[^1]\n\nТекст.\n\n[^1]: Про заголовок.\n');
  const plan = planBook({ metadata: { title: 'К', authors: [], language: '' }, chapters: [chapter] });
  const index = plan.files[0].content;
  assert.match(index, /^\| 001 \| Глава \| parts\/001\.md \| \d+ \|$/m);
  assert.doesNotMatch(index, /\[\^/);
  assert.match(index, /^- Сносок: 1$/m);
});

test('метка в заголовке подглавы: заголовок части в оглавлении без метки', () => {
  const chapter = doc(`
    <h1>Глава</h1>
    <h2>Раз<sup><a href="#n1">1</a></sup></h2><p>А.</p>
    <h2>Два</h2><p>Б.</p>
    <p id="n1">Про раз.</p>`);
  assert.deepEqual(chapter.parts.map((part) => part.title), ['Раз', 'Два']);
  assert.equal(chapter.parts[0].markdown, '# Глава\n\n## Раз[^1]\n\nА.\n\n[^1]: Про раз.\n');
});

test('висячая ссылка, ссылка на раздел с заголовком и на другой файл — не сноски', () => {
  assert.equal(only(`
    <p>Раз<sup><a href="#нет">7</a></sup>, два<sup><a href="#sec3">3</a></sup>, три<sup><a href="notes.xhtml#n1">1</a></sup>.</p>
    <section id="sec3"><h2>Раздел</h2><p>Текст раздела.</p></section>`, 'OEBPS/ch1.xhtml'),
  'Раз7, два3, три1.\n\n## Раздел\n\nТекст раздела.\n');
});

test('ссылка «этот-файл#id» — сноска, «другой-файл#id» — нет', () => {
  const body = `
    <p>Раз<sup><a href="ch1.xhtml#n1">1</a></sup>, два<sup><a href="./ch1.xhtml#n2">2</a></sup>, три<sup><a href="ch2.xhtml#n3">3</a></sup>.</p>
    <p id="n1">Первая.</p><p id="n2">Вторая.</p><p id="n3">Третья.</p>`;
  assert.equal(only(body, 'OEBPS/text/ch1.xhtml'),
    'Раз[^1], два[^2], три3.\n\nТретья.\n\n[^1]: Первая.\n[^2]: Вторая.\n');
  // Без пути документа имя файла в ссылке не разбирается.
  assert.equal(only(body), 'Раз1, два2, три3.\n\nПервая.\n\nВторая.\n\nТретья.\n');
});

test('ссылка не из <sup> и без epub:type — не сноска; число не в формате знака — тоже', () => {
  assert.equal(only(`
    <p>Раз <a href="#n1">1</a>, два<sup><a href="#n1">первая</a></sup>, три<sup><a href="#n1">1234</a></sup>.</p>
    <p id="n1">Ничья.</p>`),
  'Раз 1, двапервая, три1234.\n\nНичья.\n');
});

test('сноска внутри текста сноски не разбирается: её текст остаётся, примечание — абзацем', () => {
  assert.equal(only(`
    <h1>Г</h1>
    <p>Текст<sup><a href="#n1">1</a></sup>.</p>
    <p id="n1">1 Смотри<sup><a href="#n2">2</a></sup> ещё.</p>
    <p id="n2">Вторая.</p>`),
  '# Г\n\nТекст[^1].\n\nВторая.\n\n[^1]: Смотри2 ещё.\n');
});

test('пара «сноска в начале абзаца главы» и её примечание остаётся как есть', () => {
  assert.equal(only(`
    <p id="p1"><sup id="r1"><a href="#n1">1</a></sup> Начало абзаца.</p>
    <p id="n1"><sup><a href="#r1">1</a></sup> Примечание.</p>`),
  '1 Начало абзаца.\n\n1 Примечание.\n');
});

test('примечание из одних обратных ссылок — не сноска, всё как было', () => {
  assert.equal(only(`
    <p>Слово<sup><a href="#n1" id="r1">1</a></sup>.</p>
    <p id="n1"><a href="#r1" role="doc-backlink">↩</a></p>`),
  'Слово1.\n\n↩\n');
});

test('ссылка внутри цитаты и списка — метка на месте', () => {
  assert.equal(only(`
    <blockquote><p>Цитата<sup><a href="#n1">1</a></sup>.</p></blockquote>
    <ul><li>Пункт<sup><a href="#n2">2</a></sup></li></ul>
    <p id="n1">Первая.</p><p id="n2">Вторая.</p>`),
  '> Цитата[^1].\n\n- Пункт[^2]\n\n[^1]: Первая.\n[^2]: Вторая.\n');
});

test('блок определений — не абзац в счёте; метка в абзаце — часть абзаца', () => {
  const blocks = splitBlocks('# Г\n\nРаз[^1] и два[^2].\n\nТри.\n\n[^1]: Первая.\n[^2]: Вторая.\n');
  assert.deepEqual(blocks.map((block) => [block.kind, block.number ?? null]), [
    ['heading', null], ['paragraph', 1], ['paragraph', 2], ['definitions', null],
  ]);
  // Не в конце файла или не каждая строка — обычный абзац.
  assert.equal(splitBlocks('Раз.\n\n[^1]: Первая.\n\nДва.\n').filter((b) => b.kind === 'paragraph').length, 3);
  assert.equal(splitBlocks('Раз.\n\n[^1]: Первая.\nпродолжение\n').filter((b) => b.kind === 'paragraph').length, 2);
});

// --- Целиком: импорт файла и команда show -----------------------------------------------

const CHAPTER = xhtml(`
  <h1>Глава первая</h1>
  <h2>Часть А</h2>
  <p>Первый абзац<sup><a href="#n1" id="r1">1</a></sup>.</p>
  <p>Второй абзац.</p>
  <p>Третий абзац со сноской<sup><a href="#n2" id="r2">2</a></sup>.</p>
  <h2>Часть Б</h2>
  <p>Четвёртый абзац<sup><a href="#n1">1</a></sup>.</p>
  <section role="doc-endnotes"><hr/><h2>Примечания</h2><ol>
    <li id="n1">Общая сноска. <a href="#r1" role="doc-backlink">↩</a></li>
    <li id="n2">Другая сноска. <a href="#r2" role="doc-backlink">↩</a></li>
  </ol></section>`, 'Глава первая');
const PLAIN = xhtml('<h1>Глава вторая</h1><p>Раз.</p><p>Два.</p>', 'Глава вторая');

let tmp;
let book;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'book-agent-notes-'));
  const input = path.join(tmp, 'book.epub');
  await writeFile(input, await buildEpub({
    title: 'Книга со сносками',
    author: 'Автор',
    language: 'ru',
    items: [
      { id: 'one', href: 'one.xhtml', content: CHAPTER },
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

const run = (...args) => spawnSync(process.execPath, [SHOW, ...args], { encoding: 'utf8' });
const part = (name) => readFile(path.join(book, 'parts', `${name}.md`), 'utf8');

test('импорт: части с определениями в конце, части без сносок не тронуты', async () => {
  assert.deepEqual((await readdir(path.join(book, 'parts'))).sort(), ['001-01.md', '001-02.md', '002.md']);
  assert.equal(await part('001-01'),
    '# Глава первая\n\n## Часть А\n\nПервый абзац[^1].\n\nВторой абзац.\n\nТретий абзац со сноской[^2].\n\n'
    + '[^1]: Общая сноска.\n[^2]: Другая сноска.\n');
  assert.equal(await part('001-02'), '## Часть Б\n\nЧетвёртый абзац[^1].\n\n[^1]: Общая сноска.\n');
  assert.equal(await part('002'), '# Глава вторая\n\nРаз.\n\nДва.\n');
});

test('book.md: «Сносок» — число определений во всех частях, после «Частей»', async () => {
  const index = await readFile(path.join(book, 'book.md'), 'utf8');
  assert.match(index, /^- Частей: 3\n- Сносок: 3$/m);
  assert.doesNotMatch(index, /\[\^/);
  assert.doesNotMatch(index, /Примечания/);
});

test('show: ¶N — N-й абзац исходного EPUB, определения без номера и в диапазон не попадают', () => {
  const sources = ['Первый абзац[^1].', 'Второй абзац.', 'Третий абзац со сноской[^2].'];
  sources.forEach((text, index) => {
    const result = run(book, '001-01', `¶${index + 1}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `¶${index + 1} ${text}\n`);
  });
  const whole = run(book, '001-01');
  assert.equal(whole.stdout,
    '# Глава первая\n\n## Часть А\n\n¶1 Первый абзац[^1].\n\n¶2 Второй абзац.\n\n¶3 Третий абзац со сноской[^2].\n\n'
    + '[^1]: Общая сноска.\n[^2]: Другая сноска.\n');
  const range = run(book, '001-01', '¶1–3');
  assert.equal(range.stdout, '¶1 Первый абзац[^1].\n\n¶2 Второй абзац.\n\n¶3 Третий абзац со сноской[^2].\n');
  const beyond = run(book, '001-01', '¶4');
  assert.notEqual(beyond.status, 0);
  assert.match(beyond.stderr, /абзацев: 3, а запрошен ¶4/);
});

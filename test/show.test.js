import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEpub, xhtml } from './helpers/epub-builder.js';
import { parseRef, splitBlocks } from '../src/refs.js';
import { htmlToBlocks } from '../src/html-to-blocks.js';

const IMPORT = fileURLToPath(new URL('../bin/import.js', import.meta.url));
const SHOW = fileURLToPath(new URL('../bin/show.js', import.meta.url));

// Своя книга с известными абзацами. Глава 1 режется на 001-00, 001-01, 001-02;
// глава 2 (англ) — одна часть 002.
const FIRST = xhtml(`
  <h1>Глава первая</h1>
  <p>Вступление: ёж и йод.</p>
  <h2>Стихи</h2>
  <p>Первая строка,<br/>вторая строка.<br/><br/>Третья — после пустой.<br/><br/><br/>Четвёртая, йота.</p>
  <p>Обычный абзац про йогурт и ёлку.</p>
  <hr/>
  <ul><li>Пункт один<br/><br/>с продолжением</li><li>Пункт два</li></ul>
  <blockquote><p>Цитата, строка.<br/>&#160;<br/>Её продолжение.</p><p>Второй абзац цитаты.</p></blockquote>
  <pre>const a = 1;

# не заголовок
const b = 2;</pre>
  <p>#1 в списке — это абзац.</p>
  <h3>Мелкий</h3>
  <p>Последний абзац части.</p>
  <h2>Вторая</h2>
  <p>Единственный абзац.</p>`, 'Глава первая');
const SECOND = xhtml(`
  <h1>Chapter Two</h1>
  <p>The first English paragraph.</p>
  <p>Line one,<br/><br/>line two of the same paragraph.</p>
  <p>Third, with a <em>word</em>.</p>`, 'Chapter Two');

// Абзацы части 001-01 так, как их пишет импорт, по порядку исходника.
const VERSES = [
  'Первая строка,\nвторая строка.\nТретья — после пустой.\nЧетвёртая, йота.',
  'Обычный абзац про йогурт и ёлку.',
  '- Пункт один\n  с продолжением\n- Пункт два',
  '> Цитата, строка.\n> Её продолжение.\n>\n> Второй абзац цитаты.',
  '```\nconst a = 1;\n\n# не заголовок\nconst b = 2;\n```',
  '#1 в списке — это абзац.',
  'Последний абзац части.',
];
const ENGLISH = [
  'The first English paragraph.',
  'Line one,\nline two of the same paragraph.',
  'Third, with a *word*.',
];

let tmp;
let book;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'book-agent-show-'));
  const input = path.join(tmp, 'book.epub');
  await writeFile(input, await buildEpub({
    title: 'Книга для ссылок',
    author: 'Автор',
    language: 'ru',
    items: [
      { id: 'one', href: 'one.xhtml', content: FIRST },
      { id: 'two', href: 'two.xhtml', content: SECOND },
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

function show(...args) {
  return spawnSync(process.execPath, [SHOW, ...args], { encoding: 'utf8' });
}

function ok(...args) {
  const result = show(...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function fails(args, pattern) {
  const result = show(...args);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
  assert.equal(result.stdout, '');
}

test('¶N — текст N-го абзаца исходного EPUB', () => {
  VERSES.forEach((text, index) => {
    assert.equal(ok(book, '001-01', `¶${index + 1}`), `¶${index + 1} ${text}\n`);
  });
  ENGLISH.forEach((text, index) => {
    assert.equal(ok(book, '002', `¶${index + 1}`), `¶${index + 1} ${text}\n`);
  });
  assert.equal(ok(book, '001-00', '¶1'), '¶1 Вступление: ёж и йод.\n');
});

test('вся часть — с номерами абзацев, заголовки и разделители без номера', () => {
  const [p1, p2, p3, p4, p5, p6, p7] = VERSES.map((text, index) => `¶${index + 1} ${text}`);
  assert.equal(ok(book, '001-01'),
    [`## Стихи`, p1, p2, '---', p3, p4, p5, p6, '### Мелкий', p7].join('\n\n') + '\n');
  assert.equal(ok(book, '001-02'), '## Вторая\n\n¶1 Единственный абзац.\n');
});

test('диапазон — абзацы и заголовки с разделителями между ними; тире или дефис', () => {
  const numbered = VERSES.map((text, index) => `¶${index + 1} ${text}`);
  assert.equal(ok(book, '001-01', '¶2–4'), [numbered[1], '---', numbered[2], numbered[3]].join('\n\n') + '\n');
  assert.equal(ok(book, '001-01', '¶6-7'), [numbered[5], '### Мелкий', numbered[6]].join('\n\n') + '\n');
  assert.equal(ok(book, '002', '¶2–2'), `¶2 ${ENGLISH[1]}\n`);
});

test('ссылка одним аргументом, как из саммари', () => {
  const expected = `¶2 ${VERSES[1]}\n`;
  assert.equal(ok(book, '001-01 ¶2'), expected);
  assert.equal(ok(book, '001-01¶2'), expected);
  assert.equal(ok(book, '001-01 ¶ 2'), expected);
});

test('номер без ¶ и неверное имя части — ошибка с форматом, до обращения к файлам', () => {
  const missing = path.join(tmp, 'нет-такой-книги');
  fails([missing, '001-01', '2'], /Ошибка: .*нужен знак ¶.*003-02 ¶12/);
  fails([missing, '001-01 2'], /нужен знак ¶/);
  fails([missing, '1-1', '¶2'], /Ошибка: «1-1» — не имя части.*NNN или NNN-MM/);
  fails([missing, '001-1'], /не имя части/);
  fails([missing, '001-01-02'], /не имя части/);
  fails([missing, '001-01', '¶два'], /«¶два» — не номер абзаца/);
  fails([missing, '001-01', '¶0'], /с 1/);
});

test('глава разбита на подглавы — список её частей', () => {
  fails([book, '001'], /Ошибка: Часть 001 разбита: 001-00, 001-01, 001-02\./);
  fails([book, '002-01'], /Части 002-01 нет: глава 002 не разбита, её часть — 002/);
});

test('нет части или папки книги — понятная ошибка', () => {
  fails([book, '009'], /Ошибка: Части 009 нет в книге/);
  fails([path.join(tmp, 'нет-такой-книги'), '001-01'], /Ошибка: Папки книги нет: /);
  fails([tmp, '001-01'], /нет parts\/ — это не папка книги/);
});

test('номер больше числа абзацев и диапазон задом наперёд — ошибка с числом абзацев', () => {
  fails([book, '001-01', '¶8'], /В части 001-01 абзацев: 7, а запрошен ¶8\./);
  fails([book, '001-01', '¶5–9'], /абзацев: 7, а запрошен ¶5–9/);
  fails([book, '001-01', '¶5–3'], /Диапазон ¶5–3 задом наперёд.*абзацев: 7\./);
});

test('без ссылки — подсказка, как запускать', () => {
  fails([], /npm run show -- <папка книги> <часть>/);
  fails([book], /npm run show -- <папка книги> <часть>/);
});

test('правило счёта: пустая строка, блок кода, заголовок, разделитель', () => {
  const markdown = [
    '# Заголовок', '',
    'Абзац один,', 'вторая строка.', '   ',
    '#1 в списке', '',
    '####### семь решёток', '',
    '#без пробела', '',
    '---', '', '***', '', '* * *', '',
    '```', 'код', '', '## не заголовок', '```', '',
    '###### Мелкий', '',
    '- список', '- дальше', '\t',
    '--- не разделитель', '',
  ].join('\n');
  assert.deepEqual(splitBlocks(markdown).map((block) => [block.kind, block.number ?? null, block.text]), [
    ['heading', null, '# Заголовок'],
    ['paragraph', 1, 'Абзац один,\nвторая строка.'],
    ['paragraph', 2, '#1 в списке'],
    ['paragraph', 3, '####### семь решёток'],
    ['paragraph', 4, '#без пробела'],
    ['separator', null, '---'],
    ['separator', null, '***'],
    ['separator', null, '* * *'],
    ['paragraph', 5, '```\nкод\n\n## не заголовок\n```'],
    ['heading', null, '###### Мелкий'],
    ['paragraph', 6, '- список\n- дальше'],
    ['paragraph', 7, '--- не разделитель'],
  ]);
});

test('вывод оборвали (… | head) — тихий выход с кодом 0, без трассы', async () => {
  // Своя часть больше буфера канала: меньший вывод ушёл бы целиком, и обрыва не было бы.
  const dir = path.join(tmp, 'обрыв');
  await mkdir(path.join(dir, 'parts'), { recursive: true });
  await writeFile(path.join(dir, 'parts', '001.md'), 'Ёжик шёл по лесу и к вечеру нашёл дорогу домой.\n\n'.repeat(15000));
  const child = spawn(process.execPath, [SHOW, dir, '001']);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.once('data', () => child.stdout.destroy());
  const [code] = await once(child, 'close');
  assert.equal(stderr, '');
  assert.equal(code, 0);
});

test('разбор ссылки', () => {
  assert.deepEqual(parseRef('003'), { part: '003', from: null, to: null });
  assert.deepEqual(parseRef('003-02 ¶12'), { part: '003-02', from: 12, to: 12 });
  assert.deepEqual(parseRef(' 003 ¶1–40 '), { part: '003', from: 1, to: 40 });
  assert.deepEqual(parseRef('003-02¶3-5'), { part: '003-02', from: 3, to: 5 });
  assert.throws(() => parseRef('003 ¶1¶2'), /¶ больше одного раза/);
});

test('импорт: внутри абзаца, пункта и цитаты пустых строк нет, в блоке кода — остаются', () => {
  const { blocks } = htmlToBlocks(`<body>
    <p>Строфа один,<br/>строка.<br/><br/>Строфа два.</p>
    <p>А<br/>&#160;<br/>Б</p>
    <ol><li>Пункт<br/><br/><br/>дальше</li></ol>
    <blockquote><p>Раз<br/><br/>два</p></blockquote>
    <pre>x

y</pre></body>`);
  assert.deepEqual(blocks.map((block) => block.text), [
    'Строфа один,\nстрока.\nСтрофа два.',
    'А\nБ',
    '1. Пункт\n   дальше',
    '> Раз\n> два',
    '```\nx\n\ny\n```',
  ]);
});

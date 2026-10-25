import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { buildEpub, xhtml } from './helpers/epub-builder.js';

const CLI = fileURLToPath(new URL('../bin/import.js', import.meta.url));

// Своя маленькая книга: обложка-картинка, глава с подглавами (рус),
// пустая глава, глава без подглав (англ). Имена файлов в архиве идут
// в обратном порядке к порядку чтения — части должны идти по spine.
const PROLOGUE = xhtml(`
  <section epub:type="chapter">
    <h1>Пролог</h1>
    <p>Ёжик шёл домой, и йод в кармане звенел.</p>
    <h2>Утро</h2>
    <p style="color: red">Абзац с <em>курсивом</em> и <strong>жирным</strong> словом.</p>
    <h3>Мелочь</h3>
    <p>Мелкий   раздел
      на две строки.</p>
    <h2>Вечер</h2>
    <p>Ещё&#160;абзац: «ёлка», йогурт, <b><i>всё сразу</i></b>.</p>
    <script>document.write('скрипт');</script>
  </section>`, 'Пролог');
const EMPTY = xhtml('   ', 'Пустая');
const COVER = xhtml('<div class="cover"><img src="cover.png" alt="Обложка"/></div>', 'Обложка');
const ENGLISH = xhtml(`
  <h2>Chapter One</h2>
  <p>The kettle sang while Mary counted the old letters, one by one.</p>
  <ul><li>First <i>item</i></li><li>Second item</li></ul>`, 'Chapter One');

const SPEC_BOOK = {
  title: 'Тестовая книга',
  author: 'Автор Тестов',
  language: 'ru',
  items: [
    { id: 'eng', href: 'a-last.xhtml', content: ENGLISH },
    { id: 'empty', href: 'm-empty.xhtml', content: EMPTY },
    { id: 'img', href: 'cover.png', content: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' },
    { id: 'prologue', href: 'text/z-first.xhtml', content: PROLOGUE },
    { id: 'cover', href: 'cover.xhtml', content: COVER },
  ],
  spine: ['cover', 'prologue', 'empty', 'eng'],
};

let tmp;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'book-agent-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function runImport(input, output) {
  return spawnSync(process.execPath, [CLI, input, output], { encoding: 'utf8' });
}

async function writeEpub(name, book) {
  const file = path.join(tmp, name);
  await writeFile(file, await buildEpub(book));
  return file;
}

async function read(dir, file) {
  return readFile(path.join(dir, file), 'utf8');
}

test('книга раскладывается на book.md и части в порядке чтения', async () => {
  const input = await writeEpub('spec.epub', SPEC_BOOK);
  const out = path.join(tmp, 'out', 'книга');
  const result = runImport(input, out);
  assert.equal(result.status, 0, result.stderr);

  assert.deepEqual((await readdir(out)).sort(), ['book.md', 'parts']);
  assert.deepEqual((await readdir(path.join(out, 'parts'))).sort(), [
    '001-00.md', '001-01.md', '001-02.md', '002.md',
  ]);

  const index = await read(out, 'book.md');
  assert.match(index, /^# Тестовая книга\n/);
  assert.match(index, /^- Автор: Автор Тестов$/m);
  assert.match(index, /^- Язык: ru$/m);
  assert.match(index, /^- Глав: 2$/m);
  assert.match(index, /^- Частей: 4$/m);
  assert.match(index, /^\| 001 \| Пролог \| — \| \d+ \|$/m);
  assert.match(index, /^\| 001-00 \| Начало главы \| parts\/001-00\.md \| 9 \|$/m);
  assert.match(index, /^\| 001-01 \| Утро \| parts\/001-01\.md \| \d+ \|$/m);
  assert.match(index, /^\| 001-02 \| Вечер \| parts\/001-02\.md \| \d+ \|$/m);
  assert.match(index, /^\| 002 \| Chapter One \| parts\/002\.md \| 18 \|$/m);
  const order = ['| 001 ', '| 001-00 ', '| 001-01 ', '| 001-02 ', '| 002 '].map((row) => index.indexOf(row));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('текст частей — markdown, посимвольно как в исходнике, без HTML', async () => {
  const input = await writeEpub('text.epub', SPEC_BOOK);
  const out = path.join(tmp, 'text');
  assert.equal(runImport(input, out).status, 0);

  assert.equal(await read(out, 'parts/001-00.md'),
    '# Пролог\n\nЁжик шёл домой, и йод в кармане звенел.\n');
  assert.equal(await read(out, 'parts/001-01.md'),
    '## Утро\n\nАбзац с *курсивом* и **жирным** словом.\n\n### Мелочь\n\nМелкий раздел на две строки.\n');
  assert.equal(await read(out, 'parts/001-02.md'),
    '## Вечер\n\nЕщё абзац: «ёлка», йогурт, ***всё сразу***.\n');
  assert.equal(await read(out, 'parts/002.md'),
    '# Chapter One\n\nThe kettle sang while Mary counted the old letters, one by one.\n\n- First *item*\n- Second item\n');

  for (const file of await readdir(path.join(out, 'parts'))) {
    const text = await read(out, `parts/${file}`);
    assert.doesNotMatch(text, /[<>]|скрипт|console|text-indent|Обложка/, file);
  }
});

test('глава без текста до первой подглавы — без файла -00', async () => {
  const chapter = xhtml(`
    <h2>Part I</h2>
    <h3>One</h3><p>First.</p>
    <h3>Two</h3><p>Second.</p>`);
  const input = await writeEpub('no-intro.epub', {
    title: 'Book', author: 'A', language: 'en',
    items: [{ id: 'c', href: 'c.xhtml', content: chapter }],
    spine: ['c'],
  });
  const out = path.join(tmp, 'no-intro');
  assert.equal(runImport(input, out).status, 0);
  assert.deepEqual(await readdir(path.join(out, 'parts')), ['001-01.md', '001-02.md']);
  assert.equal(await read(out, 'parts/001-01.md'), '# Part I\n\n## One\n\nFirst.\n');
  assert.equal(await read(out, 'parts/001-02.md'), '## Two\n\nSecond.\n');
});

test('не EPUB — понятная ошибка, код ≠ 0, папка не создаётся', async () => {
  const input = path.join(tmp, 'not-a-book.epub');
  await writeFile(input, 'это просто текст, а не архив');
  const out = path.join(tmp, 'not-a-book');
  const result = runImport(input, out);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Ошибка: Файл не похож на EPUB/);
  assert.equal(existsSync(out), false);
});

test('битый архив — понятная ошибка, папка не создаётся', async () => {
  const whole = await buildEpub(SPEC_BOOK);
  const input = path.join(tmp, 'broken.epub');
  await writeFile(input, whole.subarray(0, Math.floor(whole.length / 2)));
  const out = path.join(tmp, 'broken');
  const result = runImport(input, out);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Ошибка: .*(EPUB|архив)/);
  assert.equal(existsSync(out), false);
});

test('zip без container.xml — не EPUB', async () => {
  const zip = new JSZip();
  zip.file('readme.txt', 'просто архив');
  const input = path.join(tmp, 'plain.zip');
  await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  const out = path.join(tmp, 'plain');
  const result = runImport(input, out);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Ошибка: Это не EPUB: в архиве нет файла META-INF\/container\.xml/);
  assert.equal(existsSync(out), false);
});

test('папка назначения не пуста — ошибка, ничего не перезаписано', async () => {
  const input = await writeEpub('busy.epub', SPEC_BOOK);
  const out = path.join(tmp, 'busy');
  await mkdir(out);
  await writeFile(path.join(out, 'book.md'), 'старое оглавление');
  const result = runImport(input, out);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Ошибка: Папка .* уже есть и не пуста/);
  assert.deepEqual(await readdir(out), ['book.md']);
  assert.equal(await read(out, 'book.md'), 'старое оглавление');
});

test('пустая папка назначения подходит', async () => {
  const input = await writeEpub('empty-dir.epub', SPEC_BOOK);
  const out = path.join(tmp, 'empty-dir');
  await mkdir(out);
  assert.equal(runImport(input, out).status, 0);
  assert.ok(existsSync(path.join(out, 'book.md')));
});

test('без аргументов — подсказка, как запускать', () => {
  const result = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm run import -- <файл\.epub\|файл\.pdf> <папка>/);
});

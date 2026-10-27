import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import SevenZip from '7z-wasm';
import { buildEpub, xhtml } from './helpers/epub-builder.js';
import { detectArchive, isBookFile, unpackArchive } from '../src/unpack.js';
import { ImportError } from '../src/errors.js';

const UNPACK = fileURLToPath(new URL('../bin/unpack.js', import.meta.url));
const PDF_BYTES = Buffer.from('%PDF-1.4\nне настоящий PDF, только байты для проверки\n');

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'unpack-'));
}

async function buildZip(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// 7z и архив с паролем собирает тот же 7-Zip, что и распаковывает.
async function build7z(files, extra = [], name = 'archive.7z') {
  const sevenZip = await SevenZip({ print: () => {}, printErr: () => {} });
  sevenZip.FS.mkdir('/src');
  for (const [file, content] of Object.entries(files)) {
    const target = `/src/${file}`;
    sevenZip.FS.mkdirTree(path.posix.dirname(target));
    sevenZip.FS.writeFile(target, content);
  }
  sevenZip.FS.chdir('/src');
  const code = sevenZip.callMain(['a', `/${name}`, ...Object.keys(files), ...extra, '-bso0', '-bsp0']);
  assert.equal(code, 0);
  return Buffer.from(sevenZip.FS.readFile(`/${name}`));
}

test('формат архива — по первым байтам', () => {
  assert.equal(detectArchive(Buffer.from('PK\u0003\u0004…')), 'zip');
  assert.equal(detectArchive(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4])), '7z');
  assert.equal(detectArchive(Buffer.from('Rar!\u001a\u0007\u0000')), 'rar');
  assert.equal(detectArchive(Buffer.from('Rar!\u001a\u0007\u0001\u0000')), 'rar');
  assert.equal(detectArchive(PDF_BYTES), null);
  assert.equal(detectArchive(Buffer.alloc(0)), null);
});

test('файл книги — по расширению, без учёта регистра', () => {
  for (const name of ['a.epub', 'Книга.PDF', 'b.fb2', 'папка/c.FB2.zip']) assert.ok(isBookFile(name), name);
  for (const name of ['a.zip', 'readme.txt', 'pdf']) assert.ok(!isBookFile(name), name);
});

test('zip: файлы с папками — в новую папку, байт в байт', async () => {
  const dir = await tempDir();
  try {
    const out = path.join(dir, 'новая');
    const data = await buildZip({ 'Книги/Книга.pdf': PDF_BYTES, 'readme.txt': 'прочти меня' });
    const result = await unpackArchive(data, out);
    assert.equal(result.kind, 'zip');
    assert.deepEqual(result.files, [
      { path: 'readme.txt', size: Buffer.byteLength('прочти меня') },
      { path: 'Книги/Книга.pdf', size: PDF_BYTES.length },
    ]);
    assert.deepEqual(await readFile(path.join(out, 'Книги', 'Книга.pdf')), PDF_BYTES);
    assert.equal(await readFile(path.join(out, 'readme.txt'), 'utf8'), 'прочти меня');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('7z — в пустую папку', async () => {
  const dir = await tempDir();
  try {
    const data = await build7z({ 'книга.pdf': PDF_BYTES });
    const result = await unpackArchive(data, dir);
    assert.equal(result.kind, '7z');
    assert.deepEqual(result.files, [{ path: 'книга.pdf', size: PDF_BYTES.length }]);
    assert.deepEqual(await readFile(path.join(dir, 'книга.pdf')), PDF_BYTES);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('путь с «..» и абсолютный не выходят за папку', async () => {
  const dir = await tempDir();
  try {
    const out = path.join(dir, 'out');
    const data = await buildZip({ '../снаружи.txt': 'a', '/корень.txt': 'b' });
    const result = await unpackArchive(data, out);
    assert.deepEqual(result.files.map((file) => file.path).sort(), ['корень.txt', 'снаружи.txt']);
    assert.deepEqual((await readdir(dir)).sort(), ['out']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ошибки: не архив, EPUB, папка с файлами, пароль, пустой архив — ничего не записано', async () => {
  const dir = await tempDir();
  try {
    const out = path.join(dir, 'out');
    await assert.rejects(unpackArchive(PDF_BYTES, out), (error) => error instanceof ImportError
      && /не похож на архив zip, 7z или rar/.test(error.message));

    const epub = await buildEpub({
      title: 'Книга', language: 'ru', items: [{ id: 'c1', href: 'c1.xhtml', content: xhtml('<p>Текст.</p>') }], spine: ['c1'],
    });
    await assert.rejects(unpackArchive(epub, out), /Это EPUB.*как есть/);

    const locked = await build7z({ 'книга.pdf': PDF_BYTES }, ['-psecret'], 'locked.zip');
    await assert.rejects(unpackArchive(locked, out), /паролем/);
    const lockedHeaders = await build7z({ 'книга.pdf': PDF_BYTES }, ['-psecret', '-mhe=on']);
    await assert.rejects(unpackArchive(lockedHeaders, out), /паролем/);

    await assert.rejects(unpackArchive(await buildZip({}), out), /нет файлов/);
    await assert.rejects(readdir(out), { code: 'ENOENT' });

    await mkdir(out);
    await writeFile(path.join(out, 'было.txt'), 'x');
    await assert.rejects(unpackArchive(await buildZip({ 'a.pdf': PDF_BYTES }), out), /не пуста/);
    assert.deepEqual(await readdir(out), ['было.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('команда: список файлов с пометкой книги; ошибка — код 1 без трассы', async () => {
  const dir = await tempDir();
  try {
    const archive = path.join(dir, 'книга.zip');
    await writeFile(archive, await buildZip({ 'Книга.pdf': PDF_BYTES, 'обложка.jpg': 'x' }));
    // Относительные пути — от INIT_CWD (её ставит npm), иначе — от cwd.
    const run = (...args) => spawnSync(process.execPath, [UNPACK, ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, INIT_CWD: dir },
    });

    const ok = run(archive, 'out');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Готово: zip, файлов: 2\./);
    assert.match(ok.stdout, new RegExp(`книга  ${path.join(dir, 'out', 'Книга.pdf').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(ok.stderr, '');

    const noBook = path.join(dir, 'без книги.zip');
    await writeFile(noBook, await buildZip({ 'обложка.jpg': 'x' }));
    const warned = run(noBook, 'out2');
    assert.equal(warned.status, 0);
    assert.match(warned.stderr, /нет файла книги/);

    const again = run(archive, 'out');
    assert.equal(again.status, 1);
    assert.match(again.stderr, /^Ошибка: Папка .* не пуста/);
    assert.doesNotMatch(again.stderr, /at /);

    assert.equal(run(archive).status, 2);
    assert.match(run(path.join(dir, 'нет.zip'), 'x').stderr, /Файл не найден/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

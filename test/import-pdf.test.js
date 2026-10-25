import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEpub, xhtml } from './helpers/epub-builder.js';

const CLI = fileURLToPath(new URL('../bin/import.js', import.meta.url));

let tmp;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'book-agent-pdf-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function runImport(input, output) {
  return spawnSync(process.execPath, [CLI, input, output], { encoding: 'utf8' });
}

test('файл .pdf, который не PDF и не EPUB, — ошибка, папка не создаётся', async () => {
  const input = path.join(tmp, 'fake.pdf');
  await writeFile(input, 'это просто текст');
  const out = path.join(tmp, 'fake');
  const result = runImport(input, out);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Ошибка: Файл не похож на PDF или EPUB/);
  assert.equal(existsSync(out), false);
});

test('EPUB с расширением .pdf импортируется как EPUB', async () => {
  const input = path.join(tmp, 'really-epub.pdf');
  await writeFile(input, await buildEpub({
    title: 'Книга', author: 'А', language: 'ru',
    items: [{ id: 'c', href: 'c.xhtml', content: xhtml('<h1>Глава</h1><p>Текст.</p>') }],
    spine: ['c'],
  }));
  const out = path.join(tmp, 'really-epub');
  const result = runImport(input, out);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(path.join(out, 'parts')), ['001.md']);
});

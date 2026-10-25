import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importEpub } from '../src/import-epub.js';
import { buildEpub, xhtml } from './helpers/epub-builder.js';

// Данные издания в шапке book.md: переводчик, издатель, год, ISBN.
// ISBN в тестах — примеры из описания стандарта, контрольные суммы сходятся.

const CHAPTER = xhtml('<h1>Глава</h1><p>Пара слов своего текста.</p>', 'Глава');

let tmp;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'book-agent-edition-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function importHeader(name, book) {
  const input = path.join(tmp, `${name}.epub`);
  await writeFile(input, await buildEpub({
    title: 'Книга',
    language: 'ru',
    items: [{ id: 'c', href: 'c.xhtml', content: CHAPTER }],
    spine: ['c'],
    ...book,
  }));
  const out = path.join(tmp, name);
  await importEpub(input, out);
  const index = await readFile(path.join(out, 'book.md'), 'utf8');
  return index.slice(0, index.indexOf('## Оглавление')).split('\n').filter((line) => line.startsWith('- '));
}

test('EPUB 2: роли в opf:role, дата публикации, ISBN без повторов', async () => {
  const header = await importHeader('epub2', {
    version: '2.0',
    metadata: `
    <dc:creator opf:role="aut" opf:file-as="Первый, Автор">Автор Первый</dc:creator>
    <dc:creator opf:role="trl">Переводчица Первая</dc:creator>
    <dc:creator opf:role="ill">Художник Иванов</dc:creator>
    <dc:contributor opf:role="trl">Переводчик Второй</dc:contributor>
    <dc:contributor opf:role="bkp">calibre (7.0)</dc:contributor>
    <dc:publisher>Издательство «Проба»</dc:publisher>
    <dc:date opf:event="modification">2020-05-01</dc:date>
    <dc:date opf:event="publication">2015-03-01</dc:date>
    <dc:identifier opf:scheme="ISBN">978-0-306-40615-7</dc:identifier>
    <dc:identifier opf:scheme="ISBN">urn:isbn:9780306406157</dc:identifier>
    <dc:identifier>0-8044-2957-X</dc:identifier>
    <dc:identifier opf:scheme="uuid">urn:uuid:0b6f4c1e-8d4a-4c5e-9a57-3c2d1e0f9a8b</dc:identifier>
    <meta name="cover" content="c"/>`,
  });
  assert.deepEqual(header, [
    '- Автор: Автор Первый, Художник Иванов',
    '- Язык: ru',
    '- Переводчик: Переводчица Первая, Переводчик Второй',
    '- Издатель: Издательство «Проба»',
    '- Год: 2015',
    '- ISBN: 978-0-306-40615-7, 0-8044-2957-X',
    '- Глав: 1',
    '- Частей: 1',
    '- Сносок: 0',
  ]);
});

test('EPUB 3: роли в <meta refines>, несколько издателей, ISBN с префиксами', async () => {
  const header = await importHeader('epub3', {
    author: 'Автор Тестов',
    language: 'en',
    metadata: `
    <dc:creator id="a1">Author One</dc:creator>
    <meta refines="#a1" property="role" scheme="marc:relators">aut</meta>
    <dc:creator id="t1">Translator One</dc:creator>
    <meta refines="#t1" property="role" scheme="marc:relators">trl</meta>
    <meta refines="#t1" property="file-as">One, Translator</meta>
    <dc:contributor id="t2">Translator Two</dc:contributor>
    <meta refines="#t2" property="role" scheme="marc:relators">trl</meta>
    <dc:contributor id="e1">Some Editor</dc:contributor>
    <meta refines="#e1" property="role" scheme="marc:relators">edt</meta>
    <dc:publisher>Press A</dc:publisher>
    <dc:publisher>Press B</dc:publisher>
    <dc:date>2019-11-02T00:00:00Z</dc:date>
    <dc:identifier>urn:isbn:978-0-306-40615-7</dc:identifier>
    <dc:identifier>isbn:0-306-40615-2</dc:identifier>
    <meta property="dcterms:modified">2021-01-01T00:00:00Z</meta>`,
  });
  assert.deepEqual(header, [
    '- Автор: Автор Тестов, Author One',
    '- Язык: en',
    '- Переводчик: Translator One, Translator Two',
    '- Издатель: Press A, Press B',
    '- Год: 2019',
    '- ISBN: 978-0-306-40615-7, 0-306-40615-2',
    '- Глав: 1',
    '- Частей: 1',
    '- Сносок: 0',
  ]);
});

test('дата 0101-01-01 и числовые не-ISBN — «не указан»', async () => {
  const header = await importHeader('calibre', {
    author: 'Автор Тестов',
    metadata: `
    <dc:date>0101-01-01T00:00:00+00:00</dc:date>
    <dc:date>2018</dc:date>
    <dc:identifier opf:scheme="calibre">1234567890</dc:identifier>
    <dc:identifier opf:scheme="MOBI-ASIN">9780306406158</dc:identifier>
    <dc:identifier>urn:uuid:0b6f4c1e-8d4a-4c5e-9a57-3c2d1e0f9a8b</dc:identifier>`,
  });
  assert.deepEqual(header, [
    '- Автор: Автор Тестов',
    '- Язык: ru',
    '- Переводчик: не указан',
    '- Издатель: не указан',
    '- Год: не указан',
    '- ISBN: не указан',
    '- Глав: 1',
    '- Частей: 1',
    '- Сносок: 0',
  ]);
});

test('без данных издания — все строки «не указан»', async () => {
  const header = await importHeader('bare', { language: '' });
  assert.deepEqual(header, [
    '- Автор: не указан',
    '- Язык: не указан',
    '- Переводчик: не указан',
    '- Издатель: не указан',
    '- Год: не указан',
    '- ISBN: не указан',
    '- Глав: 1',
    '- Частей: 1',
    '- Сносок: 0',
  ]);
});

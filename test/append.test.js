import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEpub, xhtml } from './helpers/epub-builder.js';
import { buildPdf } from './helpers/pdf-builder.js';

const IMPORT = fileURLToPath(new URL('../bin/import.js', import.meta.url));
const SHOW = fileURLToPath(new URL('../bin/show.js', import.meta.url));

// Своя книга: обложка (уходит в «Пропущено»), две главы целиком и последней — глава
// с подглавами 003-00, 003-01, 003-02.
const page = (id, body) => ({ id, href: `${id}.xhtml`, content: xhtml(body) });
const EPUB_ITEMS = [
  { id: 'cover', href: 'cover.xhtml', content: xhtml('<p>Рисунок на обложке</p>').replace('<body>', '<body epub:type="cover">') },
  page('ch1', '<h1>Глава первая</h1><p>Ёжик вышел из дома.</p>'),
  page('ch2', '<h1>Глава вторая</h1><p>Он шёл долго.</p>'),
  page('ch3', `<h1>Глава третья</h1><p>Вступление третьей.</p>
    <h2>Раздел один</h2><p>Текст раздела один.</p>
    <h2>Раздел два</h2><p>Текст раздела два.</p>`),
];

const LATIN_PAGE = (text) => [{ text, indent: true }];

let tmp;
let epubBook;
let pdfBook;
let counter = 0;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'book-agent-append-'));
  const epub = path.join(tmp, 'book.epub');
  await writeFile(epub, await buildEpub({
    title: 'Книга порциями', author: 'Автор', language: 'ru', items: EPUB_ITEMS, spine: EPUB_ITEMS.map((item) => item.id),
  }));
  epubBook = path.join(tmp, 'template-epub');
  assert.equal(run([epub, epubBook]).status, 0);

  const pdf = path.join(tmp, 'book.pdf');
  await writeFile(pdf, await buildPdf({
    pages: [LATIN_PAGE('First chapter text.'), LATIN_PAGE('Second chapter text.')],
    bookmarks: [{ title: 'One', page: 0 }, { title: 'Two', page: 1 }],
  }));
  pdfBook = path.join(tmp, 'template-pdf');
  assert.equal(run([pdf, pdfBook]).status, 0);
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function run(args, { input, env } = {}) {
  return spawnSync(process.execPath, [IMPORT, ...args], { encoding: 'utf8', input, env: { ...process.env, ...env } });
}

function ok(args, options) {
  const result = run(args, options);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const unique = (name) => path.join(tmp, `${name}-${(counter += 1)}`);

/** Свежая копия книги-образца. */
async function copyBook(template) {
  const dir = unique('book');
  await cp(template, dir, { recursive: true });
  return dir;
}

/** Файл куска: строка — как UTF-8, байты — как есть. */
async function piece(content) {
  const file = `${unique('piece')}.txt`;
  await writeFile(file, content);
  return file;
}

const read = (dir, file) => readFile(path.join(dir, file), 'utf8');

/** Всё содержимое папки: путь → текст файла или «<папка>»; папки нет — null. */
async function snapshot(dir) {
  if (!existsSync(dir)) return null;
  const out = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, full)] = entry.isFile() ? await readFile(full, 'utf8') : '<папка>';
  }
  return out;
}

/** Команда падает с кодом 1 и сообщением; папка книги — как до команды. */
async function failsUnchanged(args, dir, pattern, options) {
  const before = await snapshot(dir);
  const result = run(args, options);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, pattern);
  assert.match(result.stderr, /^Ошибка: /);
  assert.equal(result.stdout, '');
  assert.deepEqual(await snapshot(dir), before);
}

/** Первый кусок новой книги → текст parts/001.md и вывод команды. */
async function firstPiece(content, ...flags) {
  const dir = unique('new');
  const stdout = ok(['--append', await piece(content), dir, '--book-title', 'Проба', ...flags]);
  return { dir, stdout, part: await read(dir, 'parts/001.md'), index: await read(dir, 'book.md') };
}

const rowOf = (index, id) => index.split('\n').find((line) => line.startsWith(`| ${id} |`));

test('книга из EPUB с подглавами последней: кусок — часть 004, book.md правится построчно', async () => {
  const dir = await copyBook(epubBook);
  const before = await snapshot(dir);
  const indexBefore = before['book.md'];
  assert.match(indexBefore, /## Пропущено/);

  const stdout = ok(['--append', await piece('# Новая глава\n\nПервый абзац новой главы.\n\nВторой абзац.\n'), dir]);
  assert.equal(stdout, `Готово: «Новая глава» — часть 004, абзацев: 2.\nОглавление: ${path.join(dir, 'book.md')}\n`);
  assert.equal(await read(dir, 'parts/004.md'), '# Новая глава\n\nПервый абзац новой главы.\n\nВторой абзац.\n');

  const last = rowOf(indexBefore, '003-02');
  const expected = indexBefore
    .replace('\n- Глав: 3\n', '\n- Глав: 4\n')
    .replace('\n- Частей: 5\n', '\n- Частей: 6\n')
    .replace(`${last}\n`, `${last}\n| 004 | Новая глава | parts/004.md | 8 |\n`);
  assert.notEqual(expected, indexBefore);
  const after = await snapshot(dir);
  assert.equal(after['book.md'], expected);
  // «Пропущено» — на месте, сразу после таблицы оглавления; готовые части не тронуты.
  assert.match(after['book.md'], /\| 004 \| Новая глава \| parts\/004\.md \| 8 \|\n\n## Пропущено\n/);
  delete after['book.md'];
  delete after['parts/004.md'];
  delete before['book.md'];
  assert.deepEqual(after, before);
});

test('show показывает новую часть с номерами абзацев; ссылки на прежние части — те же', async () => {
  const dir = await copyBook(epubBook);
  const show = (...args) => spawnSync(process.execPath, [SHOW, dir, ...args], { encoding: 'utf8' }).stdout;
  const oldPart = show('003-01');
  const oldParagraph = show('002', '¶1');
  ok(['--append', await piece('Один.\nДва.\nТри.\n'), dir]);
  assert.equal(show('004'), '# Без названия\n\n¶1 Один.\n\n¶2 Два.\n\n¶3 Три.\n');
  assert.equal(show('004', '¶2'), '¶2 Два.\n');
  assert.equal(show('003-01'), oldPart);
  assert.equal(show('002', '¶1'), oldParagraph);
});

test('книга из PDF — так же: следующий номер после последней главы', async () => {
  const dir = await copyBook(pdfBook);
  const indexBefore = await read(dir, 'book.md');
  const stdout = ok(['--append', await piece('# Three\n\nThird chapter text.\n'), dir]);
  assert.match(stdout, /^Готово: «Three» — часть 003, абзацев: 1\.\n/);
  const last = rowOf(indexBefore, '002');
  assert.equal(await read(dir, 'book.md'), indexBefore
    .replace('\n- Глав: 2\n', '\n- Глав: 3\n')
    .replace('\n- Частей: 2\n', '\n- Частей: 3\n')
    .replace(`${last}\n`, `${last}\n| 003 | Three | parts/003.md | 4 |\n`));
});

test('два куска подряд — 004 и 005; тот же кусок ещё раз — ошибка, с --again — 006', async () => {
  const dir = await copyBook(epubBook);
  const first = await piece('# Порция А\n\nТекст порции А.\n');
  assert.match(ok(['--append', first, dir]), /часть 004/);
  assert.match(ok(['--append', await piece('# Порция Б\n\nТекст порции Б.\n'), dir]), /часть 005/);
  await failsUnchanged(['--append', first, dir], dir, /такой кусок уже есть: часть 004.*--again/);
  // Заголовок не в счёт: совпадает тело части.
  await failsUnchanged(['--append', first, dir, '--title', 'Другое имя'], dir, /такой кусок уже есть: часть 004/);
  assert.match(ok(['--append', first, dir, '--again']), /часть 006/);
  assert.equal(await read(dir, 'parts/006.md'), await read(dir, 'parts/004.md'));
  const index = await read(dir, 'book.md');
  assert.match(index, /\n- Глав: 6\n- Частей: 8\n/);
  assert.match(index, /\| 004 \| Порция А .*\n\| 005 \| Порция Б .*\n\| 006 \| Порция А .*\n\n## Пропущено/);
});

test('кусок = текст части 003-01, которая начинается с «## …», — повтор', async () => {
  const dir = await copyBook(epubBook);
  const text = await read(dir, 'parts/003-01.md');
  assert.match(text, /^## Раздел один\n/);
  await failsUnchanged(['--append', await piece(text), dir], dir, /Ошибка: такой кусок уже есть: часть 003-01\./);
  // Часть с заголовком «# …» — тело без заголовка: кусок без заголовка с тем же текстом — повтор.
  await failsUnchanged(['--append', await piece('Ёжик вышел из дома.\n'), dir], dir, /такой кусок уже есть: часть 001\./);
});

test('абзацы: без пустых строк — каждая строка абзацем, пустая строка после заголовка не в счёт', async () => {
  assert.equal((await firstPiece('Строка один.\nСтрока два.\nСтрока три.')).part,
    '# Без названия\n\nСтрока один.\n\nСтрока два.\n\nСтрока три.\n');
  const titled = await firstPiece('\n\n# Заголовок\n\nСтрока один.\nСтрока два.\nСтрока три.\n\n');
  assert.equal(titled.part, '# Заголовок\n\nСтрока один.\n\nСтрока два.\n\nСтрока три.\n');
  assert.match(titled.stdout, /^Готово: «Заголовок» — часть 001, абзацев: 3\.\n/);
});

test('абзацы: есть пустые строки — только по ним; переносы внутри остаются, пустые подряд — одна', async () => {
  const { part, stdout } = await firstPiece(
    'Первый абзац,\nего вторая строка.\n\n\n\nВторой абзац.   \n \t \nТретий,\nтоже в две строки.  \n');
  assert.equal(part, '# Без названия\n\nПервый абзац,\nего вторая строка.\n\nВторой абзац.\n\nТретий,\nтоже в две строки.\n');
  assert.match(stdout, /абзацев: 3\./);
});

test('абзацы: заголовок и разделитель — отдельным блоком, в обоих режимах', async () => {
  const lines = await firstPiece('## Раздел\nТекст под разделом.');
  assert.equal(lines.part, '# Без названия\n\n## Раздел\n\nТекст под разделом.\n');
  assert.match(lines.stdout, /абзацев: 1\./);

  const blank = await firstPiece('# Т\n## Раздел\nТекст под разделом,\nвторая строка.\n\nЕщё абзац.\n***\nПосле.\n# Ещё один\n');
  assert.equal(blank.part,
    '# Т\n\n## Раздел\n\nТекст под разделом,\nвторая строка.\n\nЕщё абзац.\n\n***\n\nПосле.\n\n# Ещё один\n');
  assert.match(blank.stdout, /абзацев: 3\./);
});

test('абзацы: блок кода — один блок, его пустые строки не включают деление по пустым строкам', async () => {
  const { part, stdout } = await firstPiece('Строка.\n```\nкод\n\n## не заголовок\n```\nПосле кода.\n');
  assert.equal(part, '# Без названия\n\nСтрока.\n\n```\nкод\n\n## не заголовок\n```\n\nПосле кода.\n');
  assert.match(stdout, /абзацев: 3\./);
});

test('сноски: строки «[^N]: » в конце — блок определений; «Сносок» растёт, в оглавлении заголовок без меток', async () => {
  const dir = await copyBook(epubBook);
  assert.match(await read(dir, 'book.md'), /\n- Сносок: 0\n/);
  const stdout = ok(['--append', await piece(
    '# Глава[^1] со сноской\nТекст со сноской[^2].\nЕщё текст.\n[^1]: Сноска в заголовке.\n[^2]: Сноска в тексте.\n'), dir]);
  assert.match(stdout, /^Готово: «Глава\[\^1\] со сноской» — часть 004, абзацев: 2\.\n/);
  assert.equal(await read(dir, 'parts/004.md'),
    '# Глава[^1] со сноской\n\nТекст со сноской[^2].\n\nЕщё текст.\n\n[^1]: Сноска в заголовке.\n[^2]: Сноска в тексте.\n');
  const index = await read(dir, 'book.md');
  assert.match(index, /\n- Сносок: 2\n/);
  assert.match(index, /\n\| 004 \| Глава со сноской \| parts\/004\.md \| \d+ \|\n/);

  const fresh = await firstPiece('Абзац[^1].\n[^1]: Одна сноска.\n');
  assert.match(fresh.index, /\n- Сносок: 1\n/);
  assert.match(fresh.stdout, /абзацев: 1\./);
});

test('заголовок: --title важнее строки «# …», «##» — не заголовок, без обоих — «Без названия»', async () => {
  const keyed = await firstPiece('# Из куска\nТекст.\n', '--title', 'Из ключа');
  assert.equal(keyed.part, '# Из ключа\n\nТекст.\n');
  assert.match(keyed.stdout, /^Готово: «Из ключа» — часть 001, абзацев: 1\.\n/);
  assert.match(keyed.index, /\n\| 001 \| Из ключа \| parts\/001\.md \| 3 \|\n/);

  assert.equal((await firstPiece('Текст.\n', '--title', 'Только ключ')).part, '# Только ключ\n\nТекст.\n');
  const deep = await firstPiece('## Не заголовок части\n\nТекст.\n');
  assert.equal(deep.part, '# Без названия\n\n## Не заголовок части\n\nТекст.\n');
  assert.match(deep.index, /\| 001 \| Без названия \|/);
});

test('вставка через stdin: «-» — стандартный ввод, а не файл «-» из папки запуска', async () => {
  const cwd = unique('cwd');
  await mkdir(cwd);
  await writeFile(path.join(cwd, '-'), 'Это файл, а не вставка.\n');
  const dir = await copyBook(epubBook);
  const stdout = ok(['--append', '-', dir], { input: '# Вставка\n\nТекст из вставки.\n', env: { INIT_CWD: cwd } });
  assert.match(stdout, /^Готово: «Вставка» — часть 004, абзацев: 1\.\n/);
  assert.equal(await read(dir, 'parts/004.md'), '# Вставка\n\nТекст из вставки.\n');
});

test('CRLF, одиночный CR и BOM — как обычные переводы строк', async () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const crlf = await firstPiece(Buffer.concat([bom, Buffer.from('# Окна\r\n\r\nАбзац,\r\nвторая строка.\r\n\r\nВторой.\r\n')]));
  assert.equal(crlf.part, '# Окна\n\nАбзац,\nвторая строка.\n\nВторой.\n');
  const cr = await firstPiece('# Старый Mac\rОдин.\rДва.\r');
  assert.equal(cr.part, '# Старый Mac\n\nОдин.\n\nДва.\n');
});

test('новая книга: book.md собирает импорт, автор — из ключа или «не указан»; следующий кусок — 002', async () => {
  const dir = unique('new-book');
  const stdout = ok(['--append', await piece('# Начало\n\nПервый абзац книги.\n'), dir,
    '--book-title', 'Моя книга', '--author', 'Я Сам']);
  assert.equal(stdout, `Готово: «Начало» — часть 001, абзацев: 1.\nОглавление: ${path.join(dir, 'book.md')}\n`);
  assert.equal(await read(dir, 'book.md'), [
    '# Моя книга',
    '',
    '- Автор: Я Сам',
    '- Язык: не указан',
    '- Переводчик: не указан',
    '- Издатель: не указан',
    '- Год: не указан',
    '- ISBN: не указан',
    '- Глав: 1',
    '- Частей: 1',
    '- Сносок: 0',
    '',
    '## Оглавление',
    '',
    '| Часть | Заголовок | Файл | Слов |',
    '| --- | --- | --- | ---: |',
    '| 001 | Начало | parts/001.md | 4 |',
    '',
  ].join('\n'));
  assert.deepEqual(Object.keys(await snapshot(dir)).sort(), ['book.md', 'parts', path.join('parts', '001.md')]);

  assert.match(ok(['--append', await piece('Продолжение.\n'), dir]), /часть 002/);
  assert.match(await read(dir, 'book.md'), /\n- Глав: 2\n- Частей: 2\n[^]*\| 001 \| Начало .*\n\| 002 \| Без названия \| parts\/002\.md \| 3 \|\n$/);

  const empty = unique('empty');
  await mkdir(empty);
  ok(['--append', await piece('Текст.\n'), empty, '--book-title', 'Без автора']);
  assert.match(await read(empty, 'book.md'), /^# Без автора\n\n- Автор: не указан\n/);
});

test('новая папка без --book-title — ошибка с подсказкой, папка не создаётся', async () => {
  const dir = unique('no-title');
  await failsUnchanged(['--append', await piece('Текст.\n'), dir], dir, /--book-title "…"/);
  assert.equal(existsSync(dir), false);
  const empty = unique('empty');
  await mkdir(empty);
  await failsUnchanged(['--append', await piece('Текст.\n'), empty], empty, /--book-title/);
});

test('--book-title или --author при готовом book.md — ошибка «не та папка»', async () => {
  const dir = await copyBook(epubBook);
  const text = await piece('Текст.\n');
  await failsUnchanged(['--append', text, dir, '--book-title', 'Другая'], dir, /книга уже заведена — не та папка\?/);
  await failsUnchanged(['--append', text, dir, '--author', 'Кто-то'], dir, /книга уже заведена — не та папка\?/);
});

test('кусок EPUB, PDF, не UTF-8, пустой — ошибка, ничего не записано', async () => {
  const dir = await copyBook(epubBook);
  const epub = await buildEpub({ title: 'X', language: 'ru', items: [page('a', '<p>Текст</p>')], spine: ['a'] });
  const pdf = await buildPdf({ pages: [LATIN_PAGE('Text.')] });
  for (const data of [epub, pdf]) {
    await failsUnchanged(['--append', await piece(data), dir], dir,
      /EPUB и PDF порцией не дописываются — импортируйте файл целиком в отдельную папку/);
  }
  // «Привет» в cp1251.
  await failsUnchanged(['--append', await piece(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])), dir], dir,
    /кусок не в UTF-8/);
  for (const text of ['', '\n \n', '# Заголовок\n', '# Заголовок\n\n— … —\n']) {
    await failsUnchanged(['--append', await piece(text), dir], dir, /кусок пуст/);
  }
  const fresh = unique('fresh');
  await failsUnchanged(['--append', await piece('# Только заголовок'), fresh, '--book-title', 'Б'], fresh, /кусок пуст/);
  await failsUnchanged(['--append', '-', dir], dir, /кусок пуст/, { input: '' });
});

test('пустой --title — ошибка', async () => {
  const dir = await copyBook(epubBook);
  await failsUnchanged(['--append', await piece('Текст.\n'), dir, '--title', ''], dir, /пустой --title/);
  await failsUnchanged(['--append', await piece('Текст.\n'), dir, '--title', '  '], dir, /пустой --title/);
});

test('папка не от импорта или book.md не тот — ошибка, ничего не записано', async () => {
  const text = await piece('Текст.\n');

  const stranger = unique('stranger');
  await mkdir(stranger);
  await writeFile(path.join(stranger, 'заметка.md'), 'чужой файл\n');
  await failsUnchanged(['--append', text, stranger], stranger, /есть файлы, но нет book\.md/);

  const edit = async (change) => {
    const dir = await copyBook(epubBook);
    await change(dir);
    return dir;
  };
  const rewrite = (dir, change) => read(dir, 'book.md').then((index) => writeFile(path.join(dir, 'book.md'), change(index)));

  const noRows = await edit((dir) => rewrite(dir, (index) => index.replace(/^\| 0\d\d.*\n/gm, '')));
  await failsUnchanged(['--append', text, noRows], noRows, /в оглавлении book\.md нет ни одной строки части/);

  const noToc = await edit((dir) => rewrite(dir, (index) => index.replace('## Оглавление', '## Содержание')));
  await failsUnchanged(['--append', text, noToc], noToc, /нет ни одной строки части/);

  const noChapters = await edit((dir) => rewrite(dir, (index) => index.replace('- Глав: 3\n', '')));
  await failsUnchanged(['--append', text, noChapters], noChapters, /нет строки «Глав» или «Частей»/);
  const noParts = await edit((dir) => rewrite(dir, (index) => index.replace('- Частей: 5\n', '')));
  await failsUnchanged(['--append', text, noParts], noParts, /нет строки «Глав» или «Частей»/);

  const extraPart = await edit((dir) => writeFile(path.join(dir, 'parts', '004.md'), '# Лишняя\n\nТекст.\n'));
  await failsUnchanged(['--append', text, extraPart], extraPart, /book\.md и parts\/ разошлись/);
  const missingPart = await edit(async (dir) => {
    for (const id of ['003-00', '003-01', '003-02']) await rm(path.join(dir, 'parts', `${id}.md`));
  });
  await failsUnchanged(['--append', text, missingPart], missingPart, /book\.md и parts\/ разошлись/);

  const crlf = await edit((dir) => rewrite(dir, (index) => index.replace(/\n/g, '\r\n')));
  await failsUnchanged(['--append', text, crlf], crlf, /book\.md не в формате импорта/);
});

test('чужие имена в parts/ и строки оглавления не того вида — пропускаются', async () => {
  const dir = await copyBook(epubBook);
  await writeFile(path.join(dir, 'parts', 'заметка.md'), 'чужой файл\n');
  await writeFile(path.join(dir, 'parts', '9999.md'), 'тоже чужой\n');
  const index = await read(dir, 'book.md');
  const last = rowOf(index, '003-02');
  await writeFile(path.join(dir, 'book.md'), index.replace(`${last}\n`, `${last}\n| 9999 | чужая строка | — | 0 |\n`));
  assert.match(ok(['--append', await piece('Текст новой главы.\n'), dir]), /часть 004/);
  assert.match(await read(dir, 'book.md'), /\| 9999 \| чужая строка \| — \| 0 \|\n\| 004 \| Без названия \| parts\/004\.md \| 5 \|\n/);
});

test('номер новой части больше 999 — ошибка', async () => {
  const dir = (await firstPiece('Текст.\n')).dir;
  await rename(path.join(dir, 'parts', '001.md'), path.join(dir, 'parts', '999.md'));
  const index = await read(dir, 'book.md');
  await writeFile(path.join(dir, 'book.md'), index.replace('| 001 | Без названия | parts/001.md |', '| 999 | Без названия | parts/999.md |'));
  await failsUnchanged(['--append', await piece('Ещё текст.\n'), dir], dir, /больше 999/);
});

test('сбой на записи book.md — новая часть убрана, папка как была', async () => {
  const dir = await copyBook(epubBook);
  await mkdir(path.join(dir, '.book.md.tmp'));
  await failsUnchanged(['--append', await piece('Текст новой главы.\n'), dir], dir, /не удалось записать \.book\.md\.tmp/);
  assert.equal(existsSync(path.join(dir, 'parts', '004.md')), false);
});

test('ключи: --append с --all и ключи порции без --append — ошибка, код 1', async () => {
  const dir = await copyBook(epubBook);
  const text = await piece('Текст.\n');
  await failsUnchanged(['--append', text, dir, '--all'], dir, /--append и --all вместе не бывают/);
  for (const extra of [['--title', 'Т'], ['--again'], ['--book-title', 'Б'], ['--author', 'А']]) {
    const out = unique('plain');
    await failsUnchanged([text, out, ...extra], out, new RegExp(`${extra[0]} — только вместе с --append`));
    assert.equal(existsSync(out), false);
  }
});

test('ключи: нет значения, неизвестный ключ, --key=value, не два пути — подсказка, код 2', async () => {
  const dir = await copyBook(epubBook);
  const text = await piece('Текст.\n');
  const before = await snapshot(dir);
  for (const args of [
    ['--append', text, dir, '--title'],
    ['--append', text, dir, '--titel', 'Т'],
    ['--append', text, dir, '--title=Т'],
    ['--append', text],
    ['--append', text, dir, dir],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /Как запускать: npm run import -- <файл\.epub\|файл\.pdf> <папка> \[--all\]/);
    assert.match(result.stderr, /npm run import -- --append <файл \| -> <папка книги> \[--title "…"\] \[--again\]/);
  }
  assert.match(run(['--append', text, dir, '--title=Т']).stderr, /отдельным аргументом/);
  assert.deepEqual(await snapshot(dir), before);
});

test('ключи — в любом месте после --', async () => {
  const dir = await copyBook(epubBook);
  const stdout = ok(['--title', 'Спереди', await piece('Текст новой главы.\n'), '--append', dir]);
  assert.match(stdout, /^Готово: «Спереди» — часть 004/);
});

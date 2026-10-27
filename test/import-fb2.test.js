import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFormat } from '../src/format.js';
import { cp1251, fb2, zipOf } from './helpers/fb2-builder.js';

// Импорт FB2 (Б-14): своя маленькая книга в FB2, собранная в тесте.

const IMPORT = fileURLToPath(new URL('../bin/import.js', import.meta.url));
const SHOW = fileURLToPath(new URL('../bin/show.js', import.meta.url));
const BOOK_TITLE = '<title><p>Своя книга</p></title>';

const CHAPTERS = `<body>${BOOK_TITLE}
<section><title><p>Первая</p></title><p>Текст первой.</p></section>
<section><title><p>Вторая</p></title><p>Начало второй.</p>
  <section><title><p>Раздел А</p></title><p>Текст А.</p>
    <section><title><p>Мелкий</p></title><p>Глубже.</p></section>
  </section>
  <section><title><p>Раздел Б</p></title><p>Текст Б.</p></section>
</section>
</body>`;

let tmp;
let count = 0;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'book-agent-fb2-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function run(script, ...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

async function saved(content, name = 'book.fb2') {
  const file = path.join(tmp, `${count++}-${name}`);
  await writeFile(file, content);
  return file;
}

/** Импорт командой: файл → папка, части и book.md. */
async function importFile(content, name) {
  const input = await saved(content, name);
  const dir = path.join(tmp, `book-${count++}`);
  const result = run(IMPORT, input, dir);
  assert.equal(result.status, 0, result.stderr);
  const index = await readFile(path.join(dir, 'book.md'), 'utf8');
  const parts = {};
  for (const file of (await readdir(path.join(dir, 'parts'))).sort()) {
    parts[file.replace(/\.md$/, '')] = await readFile(path.join(dir, 'parts', file), 'utf8');
  }
  return { dir, index, parts, stdout: result.stdout };
}

async function fails(content, pattern, name) {
  const input = await saved(content, name);
  const out = path.join(tmp, `fail-${count++}`);
  const result = run(IMPORT, input, out);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  assert.equal(existsSync(out), false);
}

test('данные издания: автор из трёх частей и псевдоним, переводчик, издатель, год, верный ISBN', async () => {
  const { index } = await importFile(fb2({
    titleInfo: `<genre>prose</genre>
      <author><first-name>Иван</first-name><middle-name>Петрович</middle-name><last-name>Сидоров</last-name></author>
      <author><nickname>Кот</nickname></author>
      <book-title>Своя  книга</book-title>
      <annotation><p>Аннотация не импортируется.</p></annotation>
      <lang>ru</lang>
      <translator><first-name>Анна</first-name><last-name>Перова</last-name></translator>`,
    publishInfo: '<publisher>Своё издательство</publisher><year>2001</year><isbn>978-0-306-40615-7</isbn>',
    bodies: CHAPTERS,
  }));
  assert.match(index, /^# Своя книга\n\n- Автор: Иван Петрович Сидоров, Кот\n- Язык: ru\n- Переводчик: Анна Перова\n- Издатель: Своё издательство\n- Год: 2001\n- ISBN: 978-0-306-40615-7\n/);
  assert.doesNotMatch(index, /Аннотация/);
});

test('ненастоящий год и неверный ISBN не пишутся; без publish-info — «не указан»', async () => {
  const wrong = await importFile(fb2({
    publishInfo: '<publisher>Издатель</publisher><year>0101</year><isbn>978-0-306-40615-8</isbn>',
    bodies: CHAPTERS,
  }));
  assert.match(wrong.index, /^- Издатель: Издатель\n- Год: не указан\n- ISBN: не указан$/m);

  const none = await importFile(fb2({ titleInfo: '<book-title>Своя книга</book-title>', bodies: CHAPTERS }));
  assert.match(none.index, /^- Автор: не указан\n- Язык: не указан\n- Переводчик: не указан\n- Издатель: не указан\n- Год: не указан\n- ISBN: не указан$/m);
});

test('главы — секции верхнего уровня, подглавы — вложенные, глубже — «###»; show по ссылке', async () => {
  const { dir, index, parts, stdout } = await importFile(fb2({ bodies: CHAPTERS }));
  assert.deepEqual(parts, {
    '001': '# Первая\n\nТекст первой.\n',
    '002-00': '# Вторая\n\nНачало второй.\n',
    '002-01': '## Раздел А\n\nТекст А.\n\n### Мелкий\n\nГлубже.\n',
    '002-02': '## Раздел Б\n\nТекст Б.\n',
  });
  assert.match(stdout, /Готово: «Своя книга» — глав: 2, частей: 4\./);
  assert.match(index, /^- Глав: 2\n- Частей: 4\n- Сносок: 0$/m);
  assert.match(index, /^\| 002 \| Вторая \| — \| \d+ \|$/m);
  assert.match(index, /^\| 002-00 \| Начало главы \| parts\/002-00\.md \| \d+ \|$/m);
  assert.match(index, /^\| 002-01 \| Раздел А \| parts\/002-01\.md \| \d+ \|$/m);
  assert.equal(index.match(/Своя книга/g).length, 1);

  const shown = run(SHOW, dir, '002-01 ¶2');
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, '¶2 Глубже.\n');
});

test('обёртка с эпиграфом книги; секция без title, пустая, с одной вложенной; title из двух p', async () => {
  const { index, parts } = await importFile(fb2({ bodies: `<body>${BOOK_TITLE}
<epigraph><p>Слова эпиграфа книги.</p><text-author>Мудрец</text-author></epigraph>
<section><title><p>Обёртка</p></title><p>Текст обёртки до глав.</p>
  <section><title><p>Глава 1</p></title><p>Один.</p></section>
  <section><p>Безымянная глава начинается так.</p></section>
  <section><title><p>Пустая</p></title></section>
  <section/>
  <section><title><p>Глава 3</p></title>
    <section><title><p>Единственная</p></title><p>Вложенная одна.</p></section>
  </section>
  <section><title><p>Глава 4</p></title><p>Вступление четвёртой.</p>
    <section><title><p>Одна</p></title><p>Вложенная после текста.</p></section>
  </section>
  <section><title><p>Глава 5</p><p>Встреча</p></title><p>Пять.</p></section>
  <section><title><p>Часть вторая!</p><empty-line/><p>Финал</p></title><p>Шесть.</p></section>
</section></body>` }));
  assert.deepEqual(parts, {
    '001': '> Слова эпиграфа книги.\n>\n> Мудрец\n\nТекст обёртки до глав.\n',
    '002': '# Глава 1\n\nОдин.\n',
    '003': 'Безымянная глава начинается так.\n',
    '004-01': '# Глава 3\n\n## Единственная\n\nВложенная одна.\n',
    '005-00': '# Глава 4\n\nВступление четвёртой.\n',
    '005-01': '## Одна\n\nВложенная после текста.\n',
    '006': '# Глава 5. Встреча\n\nПять.\n',
    '007': '# Часть вторая! Финал\n\nШесть.\n',
  });
  assert.match(index, /^\| 001 \| Слова эпиграфа книги\. Мудрец \| parts\/001\.md \| \d+ \|$/m);
  assert.match(index, /^\| 003 \| Безымянная глава начинается так\. \| parts\/003\.md \| \d+ \|$/m);
  assert.doesNotMatch(index, /Обёртка|Пустая/);
});

test('body без секций — одна глава', async () => {
  const { parts } = await importFile(fb2({ bodies: `<body>${BOOK_TITLE}<p>Раз.</p><p>Два.</p></body>` }));
  assert.deepEqual(parts, { '001': 'Раз.\n\nДва.\n' });
});

test('разметка текста: курсив, жирный, style, подзаголовки, стих, цитата, таблица; ¶ — по абзацам', async () => {
  const { dir, parts } = await importFile(fb2({ bodies: `<body>${BOOK_TITLE}
<section><title><p>Разметка</p></title>
<annotation><p>Аннотация раздела.</p></annotation>
<p>Слово <emphasis>курсивом</emphasis>, <strong>жирным</strong>, <style name="x">стилем</style>, <strikethrough>зачёркнутым</strikethrough>, H<sub>2</sub>O, <code>код</code> и <a l:href="http://example.com">ссылка</a>.</p>
<subtitle>Первый подзаголовок</subtitle>
<p>Между.</p>
<empty-line/>
<image l:href="#pic"/>
<subtitle>Второй подзаголовок</subtitle>
<poem><title><p>Стих</p></title>
<stanza><v>Строка один,</v><v>строка два.</v></stanza>
<stanza><v>Строка три,</v><v>строка четыре.</v></stanza>
<text-author>Поэт</text-author><date>1900</date></poem>
<cite><p>Цитата.</p><text-author>Автор цитаты</text-author></cite>
<table><tr><th>Имя</th><th>Год</th></tr><tr><td>Первый</td><td>1</td></tr></table>
</section></body>` }));
  assert.deepEqual(parts, {
    '001': [
      '# Разметка',
      'Слово *курсивом*, **жирным**, стилем, зачёркнутым, H2O, `код` и ссылка.',
      '### Первый подзаголовок',
      'Между.',
      '### Второй подзаголовок',
      '### Стих',
      'Строка один,\nстрока два.',
      'Строка три,\nстрока четыре.',
      'Поэт',
      '1900',
      '> Цитата.\n>\n> Автор цитаты',
      'Имя | Год\nПервый | 1',
    ].join('\n\n') + '\n',
  });
  const shown = run(SHOW, dir, '001', '¶3–4');
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, '¶3 Строка один,\nстрока два.\n\n¶4 Строка три,\nстрока четыре.\n');
  assert.equal(run(SHOW, dir, '001', '¶8').stdout, '¶8 Имя | Год\nПервый | 1\n');
});

test('body notes и comments — главами в конце, одной частью, секции — «###»', async () => {
  const { index, parts } = await importFile(fb2({ bodies: `<body>${BOOK_TITLE}
<section><title><p>Глава</p></title><p>Текст главы.</p></section></body>
<body name="notes"><title><p>Примечания</p></title>
<section id="n1"><title><p>1</p></title><p>Первое примечание.</p></section>
<section id="n2"><title><p>2</p></title><p>Второе.</p>
  <section><title><p>2а</p></title><p>Вложенное.</p></section></section></body>
<body name="comments"><section><title><p>к</p></title><p>Комментарий.</p></section></body>` }));
  assert.deepEqual(parts, {
    '001': '# Глава\n\nТекст главы.\n',
    '002': '# Примечания\n\n### 1\n\nПервое примечание.\n\n### 2\n\nВторое.\n\n### 2а\n\nВложенное.\n',
    '003': '### к\n\nКомментарий.\n',
  });
  assert.match(index, /^\| 003 \| Примечания \| parts\/003\.md \| \d+ \|$/m);
});

test('основной body — первый без name notes/comments, даже если примечания стоят раньше', async () => {
  const { parts } = await importFile(fb2({ bodies: `
<body name="notes"><section><title><p>1</p></title><p>Примечание.</p></section></body>
<body><section><title><p>Глава</p></title><p>Текст.</p></section></body>` }));
  assert.deepEqual(parts, { '001': '# Глава\n\nТекст.\n', '002': '### 1\n\nПримечание.\n' });
});

test('windows-1251: текст и данные издания без кракозябр', async () => {
  const xml = fb2({
    encoding: 'windows-1251',
    titleInfo: '<author><first-name>Ёлкин</first-name><last-name>Пётр</last-name></author><book-title>Ёжик и ёлка</book-title><lang>ru</lang>',
    bodies: '<body><section><title><p>Глава</p></title><p>Съешь же ещё этих мягких французских булок, да выпей чаю. ЁЖ ёж.</p></section></body>',
  });
  const { index, parts } = await importFile(cp1251(xml));
  assert.match(index, /^# Ёжик и ёлка\n\n- Автор: Ёлкин Пётр\n/);
  assert.equal(parts['001'], '# Глава\n\nСъешь же ещё этих мягких французских булок, да выпей чаю. ЁЖ ёж.\n');
});

test('BOM UTF-8 и файл без пролога; формат — по содержимому', async () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(fb2({ bodies: CHAPTERS }))]);
  assert.equal((await importFile(bom)).parts['001'], '# Первая\n\nТекст первой.\n');
  const bare = Buffer.from(fb2({ bodies: CHAPTERS, encoding: null }));
  assert.equal((await importFile(bare, 'book.txt')).parts['001'], '# Первая\n\nТекст первой.\n');

  const bytes = (text) => new TextEncoder().encode(text);
  assert.equal(detectFormat(bom), 'fb2');
  assert.equal(detectFormat(bytes('<?xml version="1.0"?>\n<!-- c --><!DOCTYPE FictionBook [<!ENTITY a "b">]>\n<FictionBook>')), 'fb2');
  assert.equal(detectFormat(bytes('<fb:FictionBook xmlns:fb="x"/>')), 'fb2');
  assert.equal(detectFormat(bytes('<?xml version="1.0"?><html><FictionBook/></html>')), null);
  assert.equal(detectFormat(bytes('<FictionBookX/>')), null);
  assert.equal(detectFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])), 'epub');
});

test('.fb2.zip с одним .fb2 — как сам .fb2; два .fb2 — ошибка', async () => {
  const xml = fb2({ bodies: CHAPTERS });
  const plain = await importFile(Buffer.from(xml));
  const zipped = await importFile(await zipOf({ 'folder/Book.FB2': xml, 'readme.txt': 'x' }), 'book.fb2.zip');
  assert.deepEqual(zipped.parts, plain.parts);
  assert.equal(zipped.index, plain.index);

  await fails(await zipOf({ 'a.fb2': xml, 'b/c.fb2': xml }), /Ошибка: в архиве несколько книг FB2 — распакуйте нужную/, 'two.zip');
  // Без .fb2 и без container.xml — прежняя ошибка EPUB.
  await fails(await zipOf({ 'a.txt': 'x' }), /Ошибка: Это не EPUB: в архиве нет файла META-INF\/container\.xml/, 'none.zip');
});

test('битый XML, неизвестная кодировка, не FB2 — понятная ошибка, папки нет', async () => {
  await fails('<?xml version="1.0"?>\n<FictionBook><body><p>Раз</body></FictionBook>', /Ошибка: FB2 не разобрался: .+/);
  await fails('<?xml version="1.0" encoding="x-foo"?>\n<FictionBook/>', /Ошибка: неизвестная кодировка FB2: x-foo/);
  await fails('<?xml version="1.0"?>\n<FictionBook><body/></FictionBook>', /Ошибка: В книге FB2 не нашлось текста/);
  for (const text of ['просто текст', '<?xml version="1.0"?><html/>']) {
    await fails(text, /Ошибка: Файл не похож на PDF или EPUB, и это не FB2\./, 'book.txt');
    await fails(text, /Ошибка: Файл не похож на PDF или EPUB/, 'book.txt');
  }
});

test('подсказка команды называет FB2', () => {
  const result = run(IMPORT);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Как запускать: npm run import -- .*файл\.fb2 и файл\.fb2\.zip/);
});

test('--append с FB2 — ошибка; кусок текста после книги из FB2 — следующий номер главы', async () => {
  const { dir } = await importFile(fb2({ bodies: CHAPTERS }));
  const before = await readFile(path.join(dir, 'book.md'), 'utf8');
  const book = await saved(fb2({ bodies: CHAPTERS }));
  const refused = run(IMPORT, '--append', book, dir);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Ошибка: FB2 порцией не дописывается — импортируйте файл целиком в отдельную папку/);
  assert.equal(await readFile(path.join(dir, 'book.md'), 'utf8'), before);

  const piece = await saved('# Новая глава\n\nАбзац новой главы.\n', 'piece.txt');
  const result = run(IMPORT, '--append', piece, dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /часть 003/);
  assert.equal(await readFile(path.join(dir, 'parts', '003.md'), 'utf8'), '# Новая глава\n\nАбзац новой главы.\n');
  assert.match(await readFile(path.join(dir, 'book.md'), 'utf8'), /^- Глав: 3$/m);
});

// Собирает test/fixtures/book.pdf и edges.pdf — маленькие книги из своего текста (рус + англ, «ё», «й»).
// Запуск: npm run fixtures:pdf -- <шрифт.ttf>
// Шрифт в репо не кладётся; на Ubuntu подойдёт /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf.
//
// Что внутри: титул до первой закладки; глава 1 с одной подглавой, абзац через границу
// страниц; глава 2 с двумя подглавами, её закладка — именованное назначение и написана
// иначе, чем напечатанный заголовок (регистр, пробелы); закладка третьего уровня текст не делит.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildPdf } from '../helpers/pdf-builder.js';

export const BOOK = {
  title: 'Тестовая книга',
  author: 'Йозеф Ёлкин',
  pages: [
    [{ text: 'Тестовая книга', size: 16 }],
    [
      { text: 'Глава первая', size: 16 },
      { text: 'Вступление к главе: ёж, йод и', indent: true, gap: 8 },
      { text: 'немного English text.' },
      { text: 'Утро', size: 14, gap: 8 },
      { text: 'Ёжик шёл домой по тропинке,', indent: true, gap: 8 },
      { text: 'и йод звенел в кармане.' },
      { text: 'Второй абзац начинается здесь', indent: true },
      { text: 'и переходит на следующую' },
    ],
    [
      { text: 'страницу без отступа.' },
      { text: 'Third paragraph, in English,', indent: true },
      { text: 'ends with «ёлка».' },
    ],
    [
      { text: 'Chapter Two', size: 16 },
      { text: 'Before the first section,', indent: true, gap: 8 },
      { text: 'two lines long.' },
      { text: 'Вечер', size: 14, gap: 8 },
      { text: 'Короткий абзац вечера,', indent: true, gap: 8 },
      { text: 'тоже в две строки.' },
      { text: 'Ночь', size: 14, gap: 8 },
      { text: 'Последний абзац', indent: true, gap: 8 },
      { text: 'всей книги' },
      { text: 'кончается тут.' },
    ],
  ],
  bookmarks: [
    { title: 'Глава первая', page: 1, children: [
      { title: 'Утро', page: 1, line: 3 },
    ] },
    { title: 'CHAPTER  two', page: 3, name: 'chapter-two', children: [
      { title: 'Вечер', page: 3, line: 3 },
      { title: 'Ночь', page: 3, line: 6, children: [
        { title: 'Глубже', page: 3, line: 8 },
      ] },
    ] },
  ],
};

export const BOOK_PDF = fileURLToPath(new URL('./book.pdf', import.meta.url));

// Книга с колонтитулами — test/fixtures/edges.pdf, 6 страниц (400 × 500, полоса у края — 40).
// Вверху: «Йозеф Ёлкин» на чётных страницах (с 0), «Края страницы» на нечётных; на стр. 4
// (начало части) верхнего колонтитула нет — автор стоит только на 2 страницах из 6, но на 2 из 3 чётных.
// Внизу: «Края страницы. Тестовая книга» на всех и номер страницы (5…10); на стр. 2 ещё год «1924».
// В тексте: переносы (в том числе через границу страниц и с «‐» U+2010), «кто-нибудь» внутри строки,
// мягкий перенос (U+00AD) внутри строки.
const SMALL = 9;
const author = { text: 'Йозеф Ёлкин', size: SMALL, at: { y: 475 } };
const title = { text: 'Края страницы', size: SMALL, at: { x: 280, y: 475 } };
const footer = { text: 'Края страницы. Тестовая книга', size: SMALL, at: { y: 28 } };
const pageNumber = (number) => ({ text: String(number), size: SMALL, at: { x: 195, y: 12 } });

export const EDGES = {
  title: 'Края страницы',
  author: 'Йозеф Ёлкин',
  pages: [
    [
      author,
      { text: 'Первая часть', size: 16 },
      { text: 'Колонтитулы стоят у краёв', indent: true, gap: 8 },
      { text: 'страницы, а текст между ними' },
      { text: 'идёт своим чередом, и пере-' },
      { text: 'носы в нём склеиваются.' },
      footer, pageNumber(5),
    ],
    [
      title,
      { text: 'Если кто-нибудь спросит, зачем', indent: true },
      { text: 'это нужно, ответ простой: чтобы' },
      { text: 'читать без помех. Слово на гра-' },
      footer, pageNumber(6),
    ],
    [
      author,
      { text: 'нице страниц тоже склеится.' },
      { text: 'Год внизу этой страницы — не', indent: true },
      { text: 'номер страницы, он остаётся.' },
      footer, pageNumber(7),
      { text: '1924', size: SMALL, at: { x: 300, y: 38 } },
    ],
    [
      title,
      { text: 'Мягкий пере­нос внутри строки', indent: true },
      { text: 'исчезает, слово остаётся целым.' },
      footer, pageNumber(8),
    ],
    [
      { text: 'Вторая часть', size: 16 },
      { text: 'Здесь у верхнего края нет', indent: true, gap: 8 },
      { text: 'колонтитула, а внизу он есть.' },
      footer, pageNumber(9),
    ],
    [
      title,
      { text: 'The last page is in English: a well-', indent: true },
      { text: 'known word and a hyphen‐' },
      { text: 'ated one are both joined.' },
      footer, pageNumber(10),
    ],
  ],
  bookmarks: [
    { title: 'Первая часть', page: 0 },
    { title: 'Вторая часть', page: 4 },
  ],
};

export const EDGES_PDF = fileURLToPath(new URL('./edges.pdf', import.meta.url));

// npm test (node --test) запускает и этот файл как тест — тогда он только описывает книги.
const runDirectly = process.argv[1] === fileURLToPath(import.meta.url) && !process.env.NODE_TEST_CONTEXT;
if (runDirectly) {
  const fontFile = process.argv[2];
  if (!fontFile) {
    console.error('Как запускать: npm run fixtures:pdf -- <шрифт.ttf>');
    process.exit(2);
  }
  for (const [file, book] of [[BOOK_PDF, BOOK], [EDGES_PDF, EDGES]]) {
    await writeFile(file, await buildPdf({ ...book, fontFile }));
    console.log(`Готово: ${file}`);
  }
}

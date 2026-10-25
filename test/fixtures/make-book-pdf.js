// Собирает test/fixtures/book.pdf — маленькую книгу из своего текста (рус + англ, «ё», «й»).
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

// npm test (node --test) запускает и этот файл как тест — тогда он только описывает книгу.
const runDirectly = process.argv[1] === fileURLToPath(import.meta.url) && !process.env.NODE_TEST_CONTEXT;
if (runDirectly) {
  const fontFile = process.argv[2];
  if (!fontFile) {
    console.error('Как запускать: npm run fixtures:pdf -- <шрифт.ttf>');
    process.exit(2);
  }
  await writeFile(BOOK_PDF, await buildPdf({ ...BOOK, fontFile }));
  console.log(`Готово: ${BOOK_PDF}`);
}

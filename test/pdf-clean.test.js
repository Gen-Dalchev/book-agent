import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookWords, joinLines, removeRunningLines, removeSoftHyphens } from '../src/pdf-clean.js';
import { textLines, paragraphs } from '../src/pdf-text.js';

// Страница 0…100 по высоте: полоса у края — 8.
const BOX = { bottom: 0, top: 100 };
const line = (text, y) => ({ text, y });
const body = line('Текст страницы', 50);
const texts = (pages) => pages.map((lines) => lines.map(({ text }) => text));
const clean = (pages) => texts(removeRunningLines(pages, pages.map(() => BOX)));

test('колонтитул на половине страниц и больше — убран, без учёта цифр', () => {
  const pages = [0, 1, 2, 3].map((page) => [
    ...(page < 2 ? [line(`Глава ${page + 1}`, 95)] : []),
    body,
  ]);
  assert.deepEqual(clean(pages), [['Текст страницы'], ['Текст страницы'], ['Текст страницы'], ['Текст страницы']]);
});

test('колонтитул на меньше чем половине страниц, чётных и нечётных — остаётся', () => {
  const pages = [0, 1, 2, 3, 4, 5].map((page) => [...(page === 0 || page === 3 ? [line('Заметка', 95)] : []), body]);
  assert.deepEqual(clean(pages).map((lines) => lines.length), [2, 1, 1, 2, 1, 1]);
});

test('чередующиеся колонтитулы — по чётным и нечётным страницам', () => {
  // «Автор» на 2 из 6 страниц, но на 2 из 3 чётных; «Название» — на 2 из 3 нечётных.
  const header = ['Автор', 'Название', 'Автор', 'Название', null, null];
  const pages = header.map((text) => [...(text ? [line(text, 95)] : []), body]);
  assert.deepEqual(clean(pages), header.map(() => ['Текст страницы']));
});

test('колонтитул сравнивается у того же края; строка вне полосы у края не трогается', () => {
  const pages = [0, 1, 2, 3].map((page) => [line('Название', page < 2 ? 95 : 5), line('Название', 50)]);
  assert.deepEqual(clean(pages), [['Название'], ['Название'], ['Название'], ['Название']]);
});

test('в книге меньше 4 страниц колонтитулы не ищутся', () => {
  const pages = [0, 1, 2].map(() => [line('Название', 95), body]);
  assert.deepEqual(clean(pages), pages.map(() => ['Название', 'Текст страницы']));
});

// 6 страниц: колонтитул `${text} ${индекс + 1}` у нижнего края, на странице moved — строка moving у верхнего.
const movedHeaderBook = (text, moved, moving) => [0, 1, 2, 3, 4, 5].map((page) => [
  ...(page === moved ? [line(moving, 95)] : []),
  line('Текст страницы', 50),
  ...(page === moved ? [] : [line(`${text} ${page + 1}`, 5)]),
]);

test('колонтитул с номером из ряда у другого края — убран, на любой странице', () => {
  const all = [0, 1, 2, 3, 4, 5].map(() => ['Текст страницы']);
  assert.deepEqual(clean(movedHeaderBook('Автор. Название', 0, 'Автор. Название 1')), all);
  assert.deepEqual(clean(movedHeaderBook('Автор. Название', 3, 'Автор. Название 4')), all);
});

test('строка у другого края без числа, с числом не из ряда или с другим числом чисел — остаётся', () => {
  const kept = (text) => [[text, 'Текст страницы'], ...[1, 2, 3, 4, 5].map(() => ['Текст страницы'])];
  assert.deepEqual(clean(movedHeaderBook('Автор. Название', 0, 'Автор. Название')), kept('Автор. Название'));
  assert.deepEqual(clean(movedHeaderBook('Автор. Название', 0, 'Автор. Название 40')), kept('Автор. Название 40'));
  // Титул тома: у нижнего края «Сборник. Том 1 · 2»…, наверху стр. 0 — «Сборник. Том 1».
  assert.deepEqual(clean(movedHeaderBook('Сборник. Том 1 ·', 0, 'Сборник. Том 1')), kept('Сборник. Том 1'));
});

test('номера страниц подряд — убраны; год и сноска у края остаются', () => {
  const numbers = ['12', '— 13 —', '14 / 300', '15', '7'];
  const pages = numbers.map((number, page) => [
    body,
    ...(page === 2 ? [line('1924', 6)] : []),
    line(number, 3),
  ]);
  assert.deepEqual(clean(pages), [
    ['Текст страницы'], ['Текст страницы'], ['Текст страницы', '1924'], ['Текст страницы'], ['Текст страницы', '7'],
  ]);
});

test('номер без соседа с тем же сдвигом и число не у края — остаются', () => {
  const pages = [[body, line('3', 3)], [body], [body, line('5', 3)], [body, line('42', 50)], [body, line('43', 50)]];
  assert.deepEqual(clean(pages), [
    ['Текст страницы', '3'], ['Текст страницы'], ['Текст страницы', '5'], ['Текст страницы', '42'], ['Текст страницы', '43'],
  ]);
});

test('без краёв страницы ничего не убирается', () => {
  const pages = [0, 1, 2, 3].map((page) => [line('Название', 95), line(String(page + 1), 3)]);
  assert.deepEqual(texts(removeRunningLines(pages, [])), texts(pages));
});

const dictionary = (...words) => new Set(words);

test('перенос: дефис и строчная буква — без дефиса, если словарь книги не пишет слово через дефис', () => {
  assert.equal(joinLines('о пере-', 'носах', dictionary('переносах')), 'о переносах');
  assert.equal(joinLines('о пере-', 'носах', dictionary()), 'о переносах');
  assert.equal(joinLines('hyphen‐', 'ated', dictionary()), 'hyphenated');
  // И слитно, и через дефис — без дефиса.
  assert.equal(joinLines('какой-', 'нибудь', dictionary('какой-нибудь', 'какойнибудь')), 'какойнибудь');
  // Принятая ошибка: составное слово, которое больше нигде в книге не пишется, склеено без дефиса.
  assert.equal(joinLines('какой-', 'нибудь', dictionary()), 'какойнибудь');
  assert.equal(removeSoftHyphens('пере­нос'), 'перенос');
});

test('составное слово: через дефис есть в словаре книги, слитно нет — дефис остаётся', () => {
  const words = dictionary('какой-нибудь', 'санкт-петербург');
  assert.equal(joinLines('какой-', 'нибудь', words), 'какой-нибудь');
  assert.equal(joinLines('Какой‐', 'нибудь', words), 'Какой‐нибудь');
  // Левая часть — только буквы перед дефисом: скобка не входит.
  assert.equal(joinLines('(какой-', 'нибудь)', words), '(какой-нибудь)');
  assert.equal(joinLines('«какой-', 'нибудь»', words), '«какой-нибудь»');
});

test('перед прописной — дефис без пробела; левая часть капсом — по словарю', () => {
  assert.equal(joinLines('Петров-', 'Водкин', dictionary()), 'Петров-Водкин');
  assert.equal(joinLines('Санкт-', 'Петербург'), 'Санкт-Петербург');
  assert.equal(joinLines('ПЕРЕ-', 'НОСАХ', dictionary('переносах')), 'ПЕРЕНОСАХ');
  assert.equal(joinLines('ПЕРЕ-', 'НОСАХ', dictionary()), 'ПЕРЕНОСАХ');
  assert.equal(joinLines('ПЕТРОВ-', 'ВОДКИН', dictionary('петров-водкин')), 'ПЕТРОВ-ВОДКИН');
});

test('дефис не после буквы или следующая строка не с буквы — через пробел', () => {
  assert.equal(joinLines('стоит -', 'тире', dictionary()), 'стоит - тире');
  assert.equal(joinLines('XIX-', '1920', dictionary()), 'XIX- 1920');
  assert.equal(joinLines('слово-', '«цитата»', dictionary()), 'слово- «цитата»');
  assert.equal(joinLines('слово-', '— тире', dictionary()), 'слово- — тире');
  assert.equal(joinLines('кто-нибудь', 'спросит', dictionary()), 'кто-нибудь спросит');
});

test('словарь книги: слова не на разрыве строки, без знаков по краям и без учёта регистра', () => {
  const words = bookWords([
    { text: 'Кто-нибудь, (Какой-Нибудь) и пере-' },
    { text: 'носах сказал «слово» 1924 года.' },
    { text: 'Ещё анти‐' },
    { text: 'фашист.' },
  ]);
  assert.deepEqual([...words].sort(), [
    'года', 'ещё', 'и', 'какой-нибудь', 'кто-нибудь', 'сказал', 'слово',
  ]);
});

test('колонтитулы убираются до разбора на абзацы: абзац через страницу не рвётся', () => {
  const piece = (str, x, y) => ({ str, transform: [10, 0, 0, 10, x, y], height: 10, hasEOL: true });
  // Строки страницы: колонтитул, две строки текста [текст, x], номер страницы. Отступ — x 30.
  const pages = [
    ['Автор', ['Начало абзаца с пере-', 30], ['носом идёт', 20]],
    ['Название', ['через страницу', 20], ['и дальше,', 20]],
    ['Автор', ['пока не кон-', 20], ['чится.', 20]],
    ['Название', ['Новый абзац.', 30], ['Конец.', 20]],
  ].map(([header, first, second], page) => [
    piece(header, 200, 95),
    piece(first[0], first[1], 70),
    piece(second[0], second[1], 58),
    piece(String(page + 1), 100, 3),
  ]);
  const lines = textLines(pages, pages.map(() => BOX));
  assert.deepEqual(paragraphs(lines), [
    'Начало абзаца с переносом идёт через страницу и дальше, пока не кончится.',
    'Новый абзац. Конец.',
  ]);
});

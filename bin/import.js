#!/usr/bin/env node
// Команда импорта: npm run import -- <файл.epub|файл.pdf|файл.fb2|файл.fb2.zip> <папка> [--all]
// Формат — по содержимому файла. --all (в любом месте) — служебные страницы EPUB не пропускать.
// Порция (Б-09): npm run import -- --append <файл | -> <папка книги> [--title "…"] [--again]
// [--book-title "…" --author "…"] — кусок текста становится следующей главой; «-» — стандартный ввод.
import path from 'node:path';
import { importBook } from '../src/import.js';
import { appendPiece } from '../src/append.js';
import { readInput } from '../src/input.js';
import { ImportError } from '../src/errors.js';
import { INDEX_FILE } from '../src/layout.js';

const ALL_FLAG = '--all';
const APPEND_FLAG = '--append';
const AGAIN_FLAG = '--again';
const FLAGS = new Set([ALL_FLAG, APPEND_FLAG, AGAIN_FLAG]);
// Ключи со значением — следующим аргументом.
const VALUE_KEYS = { '--title': 'title', '--book-title': 'bookTitle', '--author': 'author' };
const STDIN = '-';

function usage(note) {
  if (note) console.error(note);
  console.error(`Как запускать: npm run import -- <файл.epub|файл.pdf> <папка> [${ALL_FLAG}] — так же файл.fb2 и файл.fb2.zip`);
  console.error(`  кусок в книгу: npm run import -- ${APPEND_FLAG} <файл | -> <папка книги> [--title "…"] [${AGAIN_FLAG}]`);
  console.error(`  первый кусок новой книги: npm run import -- ${APPEND_FLAG} <файл | -> <новая папка> --book-title "…" [--author "…"] [--title "…"]`);
  process.exit(2);
}

function fail(message) {
  console.error(`Ошибка: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const flags = new Set();
const values = {};
const paths = [];
for (let at = 0; at < args.length; at += 1) {
  const arg = args[at];
  if (FLAGS.has(arg)) {
    flags.add(arg);
  } else if (Object.hasOwn(VALUE_KEYS, arg)) {
    if (at + 1 === args.length) usage(`У ключа ${arg} нет значения.`);
    values[arg] = args[(at += 1)];
  } else if (arg.startsWith('--')) {
    const key = arg.split('=')[0];
    usage(arg.includes('=') && (FLAGS.has(key) || Object.hasOwn(VALUE_KEYS, key))
      ? `Значение ключа — отдельным аргументом: ${key} "…", а не ${arg}.`
      : `Неизвестный ключ: ${arg}.`);
  } else {
    paths.push(arg);
  }
}
if (paths.length !== 2) usage();

const append = flags.has(APPEND_FLAG);
if (append && flags.has(ALL_FLAG)) {
  fail(`${APPEND_FLAG} и ${ALL_FLAG} вместе не бывают: ${ALL_FLAG} — для импорта EPUB целиком, а кусок дописывается без него.`);
}
const appendOnly = [...Object.keys(values), ...(flags.has(AGAIN_FLAG) ? [AGAIN_FLAG] : [])];
if (!append && appendOnly.length > 0) fail(`${appendOnly.join(', ')} — только вместе с ${APPEND_FLAG}.`);

// npm запускает скрипт из корня репо; относительные пути — от папки, где набрали команду.
const base = process.env.INIT_CWD ?? process.cwd();
const output = path.resolve(base, paths[1]);

try {
  if (append) {
    const data = paths[0] === STDIN
      ? await readStdin()
      : await readInput(path.resolve(base, paths[0]), 'файл с текстом куска');
    const options = Object.fromEntries(Object.entries(values).map(([key, value]) => [VALUE_KEYS[key], value]));
    const result = await appendPiece(data, output, { ...options, again: flags.has(AGAIN_FLAG) });
    console.log(`Готово: «${result.title}» — часть ${result.part}, абзацев: ${result.paragraphs}.`);
  } else {
    const result = await importBook(path.resolve(base, paths[0]), output, { all: flags.has(ALL_FLAG) });
    for (const warning of result.warnings) console.error(`Предупреждение: ${warning}`);
    console.log(`Готово: «${result.title || 'Без названия'}» — глав: ${result.chapterCount}, частей: ${result.partCount}.`);
  }
  console.log(`Оглавление: ${path.join(output, INDEX_FILE)}`);
} catch (error) {
  if (error instanceof ImportError) {
    console.error(`Ошибка: ${error.message}`);
  } else {
    console.error('Непредвиденная ошибка при импорте:', error);
  }
  process.exit(1);
}

// Вставка: весь стандартный ввод до конца (в терминале — Ctrl-D в начале пустой строки).
async function readStdin() {
  if (process.stdin.isTTY) console.error('Вставьте текст куска и нажмите Ctrl-D в начале пустой строки.');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

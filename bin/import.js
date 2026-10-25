#!/usr/bin/env node
// Команда импорта: npm run import -- <файл.epub|файл.pdf> <папка> [--all]
// Формат — по содержимому файла. --all (в любом месте) — служебные страницы EPUB не пропускать.
import path from 'node:path';
import { importBook } from '../src/import.js';
import { ImportError } from '../src/errors.js';
import { INDEX_FILE } from '../src/layout.js';

const ALL_FLAG = '--all';
const args = process.argv.slice(2);
const paths = args.filter((arg) => arg !== ALL_FLAG);
if (paths.length !== 2) {
  console.error(`Как запускать: npm run import -- <файл.epub|файл.pdf> <папка> [${ALL_FLAG}]`);
  process.exit(2);
}

// npm запускает скрипт из корня репо; относительные пути — от папки, где набрали команду.
const base = process.env.INIT_CWD ?? process.cwd();
const [input, output] = paths.map((arg) => path.resolve(base, arg));

try {
  const result = await importBook(input, output, { all: args.includes(ALL_FLAG) });
  for (const warning of result.warnings) console.error(`Предупреждение: ${warning}`);
  console.log(`Готово: «${result.title || 'Без названия'}» — глав: ${result.chapterCount}, частей: ${result.partCount}.`);
  console.log(`Оглавление: ${path.join(output, INDEX_FILE)}`);
} catch (error) {
  if (error instanceof ImportError) {
    console.error(`Ошибка: ${error.message}`);
  } else {
    console.error('Непредвиденная ошибка при импорте:', error);
  }
  process.exit(1);
}

#!/usr/bin/env node
// Команда импорта: npm run import -- <файл.epub> <папка>
import path from 'node:path';
import { importEpub } from '../src/import-epub.js';
import { ImportError } from '../src/errors.js';
import { INDEX_FILE } from '../src/layout.js';

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('Как запускать: npm run import -- <файл.epub> <папка>');
  process.exit(2);
}

// npm запускает скрипт из корня репо; относительные пути — от папки, где набрали команду.
const base = process.env.INIT_CWD ?? process.cwd();
const [input, output] = args.map((arg) => path.resolve(base, arg));

try {
  const result = await importEpub(input, output);
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

#!/usr/bin/env node
// Команда распаковки: npm run unpack -- <архив.zip|архив.7z|архив.rar> <папка>
// Архив с книгой (большой PDF и пр.) — в новую или пустую папку; дальше — импорт книги из неё (Б-18).
import path from 'node:path';
import { unpackArchive, isBookFile } from '../src/unpack.js';
import { readInput } from '../src/input.js';
import { ImportError } from '../src/errors.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args.some((arg) => arg.startsWith('--'))) {
  console.error('Как запускать: npm run unpack -- <архив.zip|архив.7z|архив.rar> <папка>');
  process.exit(2);
}

// npm запускает скрипт из корня репо; относительные пути — от папки, где набрали команду.
const base = process.env.INIT_CWD ?? process.cwd();
const output = path.resolve(base, args[1]);

try {
  const data = await readInput(path.resolve(base, args[0]), 'архив (.zip, .7z или .rar)');
  const result = await unpackArchive(data, output);
  console.log(`Готово: ${result.kind}, файлов: ${result.files.length}.`);
  for (const file of result.files) {
    console.log(`${isBookFile(file.path) ? 'книга' : '     '}  ${path.join(output, ...file.path.split('/'))}  ${formatSize(file.size)}`);
  }
  const books = result.files.filter((file) => isBookFile(file.path));
  if (books.length === 0) console.error('Предупреждение: в архиве нет файла книги (.epub, .pdf, .fb2).');
} catch (error) {
  if (error instanceof ImportError) {
    console.error(`Ошибка: ${error.message}`);
  } else {
    console.error('Непредвиденная ошибка при распаковке:', error);
  }
  process.exit(1);
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

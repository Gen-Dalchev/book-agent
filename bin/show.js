#!/usr/bin/env node
// Команда показа: npm run show -- <папка книги> <часть> [¶N | ¶N–M]
// Ссылку можно дать и одним аргументом, как в разборе: "003-02 ¶12", 003-02¶12.
import path from 'node:path';
import { parseRef, showRef } from '../src/refs.js';
import { RefError } from '../src/errors.js';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Как запускать: npm run show -- <папка книги> <часть> [¶N | ¶N–M]');
  console.error('Например: npm run show -- out/книга 003-02 ¶12');
  process.exit(2);
}

// npm запускает скрипт из корня репо; относительные пути — от папки, где набрали команду.
const base = process.env.INIT_CWD ?? process.cwd();
const bookDir = path.resolve(base, args[0]);

try {
  const ref = parseRef(args.slice(1).join(' '));
  process.stdout.write(await showRef(bookDir, ref));
} catch (error) {
  if (error instanceof RefError) {
    console.error(`Ошибка: ${error.message}`);
  } else {
    console.error('Непредвиденная ошибка при показе части:', error);
  }
  process.exit(1);
}

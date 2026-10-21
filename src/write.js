// Запись готовых файлов книги в папку. Ничего не перезаписывает.
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ImportError } from './errors.js';

/** Папка назначения: нет — можно, пустая — можно, с файлами — ошибка. */
export async function ensureEmptyDir(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    if (error.code === 'ENOTDIR') {
      throw new ImportError(`${dir} — это файл, а не папка. Укажите новую или пустую папку.`);
    }
    throw error;
  }
  if (entries.length > 0) {
    throw new ImportError(`Папка ${dir} уже есть и не пуста. Ничего не записано: укажите новую или пустую папку.`);
  }
}

/** @param {{path: string, content: string}[]} files пути — относительно dir, через «/» */
export async function writeFiles(dir, files) {
  await ensureEmptyDir(dir);
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    const target = path.join(dir, ...file.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' });
  }
}

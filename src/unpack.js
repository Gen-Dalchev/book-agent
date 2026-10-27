// Распаковка архива с книгой (zip, 7z, rar) в новую или пустую папку — до импорта (Б-18).
// Разбор — 7-Zip, собранный в WASM (`7z-wasm`): без нативных программ, одинаково в любой сессии.
// Архив распаковывается в память, на диск переносятся только обычные файлы и только внутрь папки.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import SevenZip from '7z-wasm';
import { ImportError } from './errors.js';
import { detectFormat, ZIP_SIGNATURES } from './format.js';
import { ensureEmptyDir } from './write.js';

const SIGNATURES = {
  zip: ZIP_SIGNATURES,
  '7z': [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  rar: [[0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
};
// Файлы, которые импорт берёт как книгу (`.fb2.zip` — FB2 в zip, Б-14).
const BOOK_EXTENSIONS = ['.epub', '.pdf', '.fb2', '.fb2.zip'];
// Пароль-заглушка: без него 7-Zip ждал бы ввода; у архива без пароля он ни на что не влияет.
const NO_PASSWORD = '-pnone';
const IN = '/archive';
const OUT = '/out';

/**
 * @param {Uint8Array} data содержимое архива
 * @returns {'zip' | '7z' | 'rar' | null}
 */
export function detectArchive(data) {
  for (const [kind, signatures] of Object.entries(SIGNATURES)) {
    if (signatures.some((bytes) => bytes.every((byte, index) => data[index] === byte))) return kind;
  }
  return null;
}

/** Книга ли это для импорта — по имени файла. */
export function isBookFile(name) {
  const lower = name.toLowerCase();
  return BOOK_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * @param {Uint8Array} data содержимое архива
 * @param {string} outDir папка: не должна существовать или должна быть пустой
 * @returns {Promise<{kind: string, files: {path: string, size: number, book: boolean}[]}>}
 *   пути — относительно outDir, через «/»; book — файл книги по имени или по содержимому (PDF, FB2)
 */
export async function unpackArchive(data, outDir) {
  const kind = detectArchive(data);
  if (!kind) throw new ImportError('Файл не похож на архив zip, 7z или rar.');
  await ensureEmptyDir(outDir);

  const messages = [];
  const sevenZip = await SevenZip({ print: () => {}, printErr: (line) => messages.push(line) });
  sevenZip.FS.writeFile(IN, data);
  let code;
  // 7-Zip ставит свой код выхода в process.exitCode — код процесса решает вызывающий, а не он.
  const exitCode = process.exitCode;
  try {
    code = sevenZip.callMain(['x', IN, `-o${OUT}`, '-y', NO_PASSWORD, '-bso0', '-bsp0']);
  } catch (error) {
    // Исключение C++ внутри 7-Zip приходит числом: обрезанный архив, зашифрованное оглавление.
    if (typeof error !== 'number') throw error;
    throw new ImportError('Архив не открылся: он повреждён или защищён паролем. Ничего не записано.');
  } finally {
    process.exitCode = exitCode;
  }
  if (code !== 0) {
    // Сюда же — архив со ссылкой наружу («Dangerous link path»): 7-Zip считает его ошибкой целиком.
    const reason = messages.map((line) => line.trim()).filter(Boolean).join(' ');
    const password = /wrong password/i.test(reason) ? ' Похоже, архив защищён паролем.' : '';
    throw new ImportError(`Архив не распаковался: ${reason || `код ${code}`}.${password} Ничего не записано.`);
  }

  const files = listFiles(sevenZip.FS, OUT, '');
  if (files.length === 0) throw new ImportError('В архиве нет файлов. Ничего не записано.');
  if (kind === 'zip' && files.some((file) => file.path === 'META-INF/container.xml')) {
    throw new ImportError('Это EPUB, а не архив с книгой: импортируйте файл как есть, без распаковки. Ничего не записано.');
  }

  // Пути из памяти 7-Zip уже без «..» и корня; проверка — на случай, если это когда-нибудь изменится.
  const root = path.resolve(outDir);
  const targets = files.map((file) => path.resolve(root, ...file.path.split('/')));
  const outside = files.find((file, index) => !targets[index].startsWith(root + path.sep));
  if (outside) throw new ImportError(`Путь в архиве выходит за папку: ${outside.path}. Ничего не записано.`);

  await mkdir(root, { recursive: true });
  const result = [];
  for (const [index, file] of files.entries()) {
    const content = sevenZip.FS.readFile(`${OUT}/${file.path}`);
    await mkdir(path.dirname(targets[index]), { recursive: true });
    await writeFile(targets[index], content, { flag: 'wx' });
    // Имя в zip не в UTF-8 (cp866 старых архиваторов) приходит искажённым, без расширения, — книгу узнаём по содержимому.
    const book = isBookFile(file.path) || ['pdf', 'fb2'].includes(detectFormat(content));
    result.push({ path: file.path, size: file.size, book });
  }
  return { kind, files: result };
}

// Обычные файлы распакованного дерева по порядку имён; ссылки и прочее не переносятся.
function listFiles(fs, dir, prefix) {
  let names;
  try {
    names = fs.readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names.filter((entry) => entry !== '.' && entry !== '..').sort()) {
    const full = `${dir}/${name}`;
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstat(full);
    if (fs.isDir(stat.mode)) files.push(...listFiles(fs, full, relative));
    else if (fs.isFile(stat.mode)) files.push({ path: relative, size: stat.size });
  }
  return files;
}

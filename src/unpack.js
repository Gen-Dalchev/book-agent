// Распаковка архива с книгой (zip, 7z, rar) в новую или пустую папку — до импорта (Б-18).
// Разбор — 7-Zip, собранный в WASM (`7z-wasm`): без нативных программ, одинаково в любой сессии.
// Архив распаковывается в память, на диск переносятся только обычные файлы и только внутрь папки.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import SevenZip from '7z-wasm';
import { ImportError } from './errors.js';
import { ensureEmptyDir } from './write.js';

const SIGNATURES = {
  zip: [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]],
  '7z': [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  rar: [[0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
};
// Файлы, которые импорт берёт как книгу (`.fb2.zip` — после импорта FB2).
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
 * @returns {Promise<{kind: string, files: {path: string, size: number}[]}>} пути — относительно outDir, через «/»
 */
export async function unpackArchive(data, outDir) {
  const kind = detectArchive(data);
  if (!kind) throw new ImportError('Файл не похож на архив zip, 7z или rar.');
  await ensureEmptyDir(outDir);

  const messages = [];
  const sevenZip = await SevenZip({ print: () => {}, printErr: (line) => messages.push(line) });
  sevenZip.FS.writeFile(IN, data);
  let code;
  try {
    code = sevenZip.callMain(['x', IN, `-o${OUT}`, '-y', NO_PASSWORD, '-bso0', '-bsp0']);
  } catch {
    // 7-Zip падает целиком на архивах с зашифрованным оглавлением.
    throw new ImportError('Архив не открылся: он повреждён или защищён паролем. Ничего не записано.');
  }
  if (code !== 0) {
    const reason = messages.map((line) => line.trim()).filter(Boolean).join(' ');
    const password = /wrong password/i.test(reason) ? ' Похоже, архив защищён паролем.' : '';
    throw new ImportError(`Архив не распаковался: ${reason || `код ${code}`}.${password} Ничего не записано.`);
  }

  const files = listFiles(sevenZip.FS, OUT, '');
  if (files.length === 0) throw new ImportError('В архиве нет файлов. Ничего не записано.');
  if (kind === 'zip' && files.some((file) => file.path === 'META-INF/container.xml')) {
    throw new ImportError('Это EPUB, а не архив с книгой: импортируйте файл как есть, без распаковки. Ничего не записано.');
  }

  const root = path.resolve(outDir);
  for (const file of files) {
    const target = path.resolve(root, ...file.path.split('/'));
    if (!target.startsWith(root + path.sep)) {
      throw new ImportError(`Путь в архиве выходит за папку: ${file.path}. Ничего не записано.`);
    }
  }
  await mkdir(root, { recursive: true });
  for (const file of files) {
    const target = path.resolve(root, ...file.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, sevenZip.FS.readFile(`${OUT}/${file.path}`), { flag: 'wx' });
  }
  return { kind, files: files.map(({ path: filePath, size }) => ({ path: filePath, size })) };
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

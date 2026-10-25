// Текст страниц PDF → строки → абзацы. Не зависит от библиотеки чтения: на входе
// куски текста страницы в том виде, как их отдаёт pdfjs (str, transform, height, hasEOL).
//
// Строка — куски с одной высотой на странице (transform[5]); hasEOL обрывает строку.
// Новый абзац — промежуток между строками больше обычного для страницы в 1,5 раза
// или отступ первой строки. Первая строка страницы без отступа продолжает абзац
// с прошлой страницы. Колонтитулы и номера страниц убираются до разбора на абзацы,
// переносы склеиваются при сборке абзаца (pdf-clean.js).
import { joinLines, removeRunningLines, removeSoftHyphens } from './pdf-clean.js';

const GAP_FACTOR = 1.5;
// Отступ первой строки — сдвиг вправо от левого края страницы больше 0,8 высоты шрифта.
const INDENT_EM = 0.8;

/**
 * @typedef {{str: string, transform: number[], height?: number, hasEOL?: boolean}} TextItem
 * @typedef {{page: number, x: number, y: number, height: number, text: string, start: boolean}} Line
 *   page — с 0; y — снизу вверх, как в PDF; start — строка начинает абзац
 */

/**
 * @param {TextItem[][]} pages куски текста по страницам, в порядке страниц
 * @param {import('./pdf-clean.js').PageBox[]} [boxes] края страниц; без них колонтитулы не ищутся
 * @returns {Line[]} непустые строки всей книги по порядку
 */
export function textLines(pages, boxes = []) {
  const lines = [];
  removeRunningLines(pages.map(splitLines), boxes).forEach((pageLines, page) => {
    const left = Math.min(...pageLines.map((line) => line.x));
    const normalGap = median(gaps(pageLines).filter((gap) => gap > 0));
    pageLines.forEach((line, index) => {
      const indented = line.x - left > INDENT_EM * line.height;
      const gap = index > 0 ? pageLines[index - 1].y - line.y : 0;
      const wideGap = normalGap > 0 && gap > GAP_FACTOR * normalGap;
      const start = lines.length === 0 || indented || wideGap;
      lines.push({ page, ...line, start });
    });
  });
  return lines;
}

function splitLines(items) {
  const lines = [];
  let current = null;
  let broken = false;
  for (const item of items) {
    // Положение строки — по кускам с буквами: пробелы и пустые куски конца строки
    // бывают с нулевыми координатами.
    if (item.str.trim()) {
      const y = item.transform[5];
      const height = item.height || Math.abs(item.transform[3]) || 0;
      const sameLine = current && !broken && Math.abs(y - current.y) <= Math.max(current.height, height) / 2;
      if (!sameLine) {
        current = { x: item.transform[4], y, height, text: '' };
        lines.push(current);
      }
      current.height = Math.max(current.height, height);
      broken = false;
    }
    if (current) current.text += item.str;
    if (item.hasEOL) broken = true;
  }
  return lines
    .map((line) => ({ ...line, text: line.text.replace(/\s+/gu, ' ').trim() }))
    .filter((line) => line.text);
}

function gaps(lines) {
  return lines.slice(1).map((line, index) => lines[index].y - line.y);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Строки куска книги → абзацы: строки одного абзаца склеены через пробел, переносы — без дефиса.
 * Первая строка куска всегда начинает абзац.
 * @param {Line[]} lines
 * @returns {string[]}
 */
export function paragraphs(lines) {
  const result = [];
  lines.forEach((line, index) => {
    if (index === 0 || line.start) result.push(line.text);
    else result[result.length - 1] = joinLines(result[result.length - 1], line.text);
  });
  return result.map(removeSoftHyphens);
}

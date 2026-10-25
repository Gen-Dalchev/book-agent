// Очистка строк PDF: колонтитулы и номера страниц у краёв страницы, переносы слов.
// Пороги — здесь, в одном месте: поправить по первой настоящей книге.

// Полоса у верхнего и нижнего края, где ищутся колонтитулы и номера, — доля высоты страницы.
export const EDGE_BAND = 0.08;
// Колонтитул стоит у того же края хотя бы на такой доле страниц книги — всех, чётных или нечётных.
export const RUNNING_SHARE = 0.5;
// В книге короче колонтитулы не ищутся.
export const MIN_PAGES_FOR_HEADERS = 4;

// Номер страницы: одно число, «— 12 —» или «12 / 300».
const PAGE_NUMBER = /^(?:[-–—]\s*)?(\d+)(?:\s*[-–—]|\s*\/\s*\d+)?$/u;
const SOFT_HYPHEN = '­';
// Разрыв слова: строка кончается на «-» или «‐» (U+2010) сразу после буквы, следующая — с буквы.
const HYPHEN_END = /(?<=\p{L})[-‐]$/u;
const LETTER_START = /^\p{L}/u;
const UPPERCASE_START = /^[\p{Lu}\p{Lt}]/u;
const ALL_UPPERCASE = /^[\p{Lu}\p{M}]+$/u;
// Части разорванного слова: подряд буквы перед дефисом и в начале следующей строки.
const LEFT_PART = /[\p{L}\p{M}]+(?=[-‐]$)/u;
const RIGHT_PART = /^[\p{L}\p{M}]+/u;
// Слово словаря: подряд буквы и дефисы; знаки препинания по краям отрезаются.
const EDGE_NON_LETTERS = /^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu;
const WORD = /^[\p{L}\p{M}-]+$/u;

/**
 * Края страницы в координатах PDF (y снизу вверх).
 * @typedef {{bottom: number, top: number}} PageBox
 */

/**
 * Убирает колонтитулы и номера страниц.
 * @template {{y: number, text: string}} L
 * @param {L[][]} pageLines строки по страницам
 * @param {PageBox[]} boxes края страниц; у страницы без краёв ничего не убирается
 * @returns {L[][]}
 */
export function removeRunningLines(pageLines, boxes) {
  const edges = pageLines.map((lines, page) => lines.map((line) => edgeOf(line, boxes[page])));
  const headers = runningHeaders(pageLines, edges);
  const numbers = pageNumbers(pageLines, edges);
  return pageLines.map((lines, page) => lines.filter((line, index) => {
    const edge = edges[page][index];
    return !edge || !(headers.has(headerKey(edge, line.text)) || numbers.has(line));
  }));
}

function edgeOf(line, box) {
  if (!box) return null;
  const band = (box.top - box.bottom) * EDGE_BAND;
  if (line.y >= box.top - band) return 'top';
  if (line.y <= box.bottom + band) return 'bottom';
  return null;
}

// Колонтитул сравнивается без цифр: «Глава 3» и «Глава 4» — одна строка.
// Строка без букв (номер, год) колонтитулом не считается.
function headerKey(edge, text) {
  const words = text.replace(/\p{Nd}/gu, '').replace(/\s+/gu, ' ').trim();
  return /\p{L}/u.test(words) ? `${edge}\n${words}` : null;
}

function runningHeaders(pageLines, edges) {
  const found = new Set();
  const total = pageLines.length;
  if (total < MIN_PAGES_FOR_HEADERS) return found;
  const counts = new Map();
  pageLines.forEach((lines, page) => {
    const keys = new Set(lines.map((line, index) => edges[page][index] && headerKey(edges[page][index], line.text)));
    for (const key of keys) {
      if (!key) continue;
      const count = counts.get(key) ?? { all: 0, even: 0, odd: 0 };
      count.all += 1;
      count[page % 2 === 0 ? 'even' : 'odd'] += 1;
      counts.set(key, count);
    }
  });
  const even = Math.ceil(total / 2);
  const odd = total - even;
  for (const [key, count] of counts) {
    if (count.all >= RUNNING_SHARE * total || count.even >= RUNNING_SHARE * even || count.odd >= RUNNING_SHARE * odd) {
      found.add(key);
    }
  }
  return found;
}

// Номер страницы — число у края, у которого на соседней странице есть число с тем же сдвигом
// от номера страницы в файле. Год или номер сноски ряда не продолжают и остаются.
function pageNumbers(pageLines, edges) {
  const candidates = pageLines.map((lines, page) => lines
    .filter((line, index) => edges[page][index] && PAGE_NUMBER.test(line.text))
    .map((line) => ({ line, shift: Number(PAGE_NUMBER.exec(line.text)[1]) - page })));
  const shifts = candidates.map((list) => new Set(list.map(({ shift }) => shift)));
  const found = new Set();
  candidates.forEach((list, page) => {
    for (const { line, shift } of list) {
      if (shifts[page - 1]?.has(shift) || shifts[page + 1]?.has(shift)) found.add(line);
    }
  });
  return found;
}

/**
 * Словарь книги — как слова написаны не на разрыве строки: слова всех строк, кроме последнего слова
 * строки, которая кончается дефисом после буквы, и первого слова строки после неё.
 * Слова — в нижнем регистре, «‐» (U+2010) — как «-».
 * @param {{text: string}[]} lines строки всей книги по порядку, без колонтитулов и номеров страниц
 * @returns {Set<string>}
 */
export function bookWords(lines) {
  const words = new Set();
  lines.forEach((line, index) => {
    const tokens = removeSoftHyphens(line.text).split(/\s+/u);
    const from = index > 0 && HYPHEN_END.test(lines[index - 1].text) ? 1 : 0;
    const to = HYPHEN_END.test(line.text) ? tokens.length - 1 : tokens.length;
    for (const token of tokens.slice(from, to)) {
      const word = normalizeWord(token.replace(EDGE_NON_LETTERS, ''));
      if (WORD.test(word)) words.add(word);
    }
  });
  return words;
}

function normalizeWord(word) {
  return word.replaceAll('‐', '-').toLowerCase();
}

/**
 * Склеивает строку абзаца со следующей. Строка кончается дефисом после буквы, следующая начинается
 * с буквы — слово разорвано:
 * - следующая с прописной, а левая часть не вся из прописных — дефис остаётся, без пробела
 *   («Петров-» + «Водкин» → «Петров-Водкин»);
 * - иначе решает словарь книги без учёта регистра: «левая-правая» в нём есть, а «леваяправая» нет —
 *   дефис остаётся («какой-» + «нибудь» → «какой-нибудь»); иначе — без дефиса («пере-» + «носах»).
 * В остальных случаях — через пробел.
 * Принятая ошибка: составное слово, которое в книге больше нигде не пишется через дефис, склеится без дефиса.
 * @param {string} text
 * @param {string} next
 * @param {Set<string>} [words] словарь книги (bookWords)
 * @returns {string}
 */
export function joinLines(text, next, words = new Set()) {
  if (!HYPHEN_END.test(text) || !LETTER_START.test(next)) return `${text} ${next}`;
  const left = LEFT_PART.exec(removeSoftHyphens(text))?.[0] ?? '';
  const right = RIGHT_PART.exec(removeSoftHyphens(next))?.[0] ?? '';
  if (UPPERCASE_START.test(next) && !ALL_UPPERCASE.test(left)) return text + next;
  const compound = words.has(normalizeWord(`${left}-${right}`)) && !words.has(normalizeWord(left + right));
  return compound ? text + next : text.slice(0, -1) + next;
}

/**
 * Мягкие переносы (U+00AD) убираются из текста всегда. pdfjs их и так не отдаёт (невидимый знак),
 * в том числе в конце строки — там слово остаётся разорванным пробелом.
 */
export function removeSoftHyphens(text) {
  return text.replaceAll(SOFT_HYPHEN, '');
}

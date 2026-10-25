// Слово — подряд идущие непробельные символы, среди которых есть буква или цифра.
// Так разметка markdown (#, *, -) не считается словами. Метка определения сноски
// «[^N]:» в начале строки — тоже разметка; текст сноски за ней считается.
const DEFINITION_LABEL = /^\[\^\d+\]:(?=\s|$)/gmu;

export function countWords(text) {
  let count = 0;
  for (const token of text.replace(DEFINITION_LABEL, '').split(/\s+/u)) {
    if (/[\p{L}\p{N}]/u.test(token)) count += 1;
  }
  return count;
}

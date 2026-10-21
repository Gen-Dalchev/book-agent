// Слово — подряд идущие непробельные символы, среди которых есть буква или цифра.
// Так разметка markdown (#, *, -) не считается словами.
export function countWords(text) {
  let count = 0;
  for (const token of text.split(/\s+/u)) {
    if (/[\p{L}\p{N}]/u.test(token)) count += 1;
  }
  return count;
}

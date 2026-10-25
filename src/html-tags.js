// Общее для разбора XHTML глав: типы узлов и наборы тегов.
export const ELEMENT = 1;
export const TEXT = 3;

export const HEADING_LEVELS = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
export const SKIP = new Set([
  'head', 'title', 'script', 'style', 'noscript', 'template', 'svg', 'math',
  'img', 'image', 'picture', 'audio', 'video', 'object', 'embed', 'iframe', 'canvas',
  'input', 'button', 'select', 'textarea',
]);
export const BLOCK = new Set([
  'html', 'body', 'main', 'article', 'section', 'nav', 'aside', 'header', 'footer',
  'div', 'p', 'blockquote', 'pre', 'hr', 'address', 'center', 'figure', 'figcaption',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

export function tagOf(element) {
  return (element.rawTagName ?? '').toLowerCase();
}

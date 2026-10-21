// Ошибка, понятная читателю: текст по-русски выводится как есть, без стека.
export class ImportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ImportError';
  }
}

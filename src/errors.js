// Ошибка, понятная читателю: текст по-русски выводится как есть, без стека.
export class ImportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ImportError';
  }
}

// То же для ссылок на место («003-02 ¶12»): неверная ссылка, нет части или абзаца.
export class RefError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RefError';
  }
}

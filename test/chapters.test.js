import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitDocument, buildChapters } from '../src/chapters.js';
import { htmlToBlocks } from '../src/html-to-blocks.js';
import { planBook } from '../src/layout.js';

const chapter = (body) => splitDocument(htmlToBlocks(`<html><body>${body}</body></html>`));

test('один подзаголовок — глава не режется', () => {
  const result = chapter('<h1>Глава</h1><p>Текст.</p><h2>Единственный</h2><p>Ещё.</p>');
  assert.equal(result.parts.length, 1);
  assert.equal(result.parts[0].markdown, '# Глава\n\nТекст.\n\n## Единственный\n\nЕщё.\n');
});

test('подглава — верхний из повторяющихся уровней, а не просто верхний', () => {
  const result = chapter(`
    <h1>Глава</h1>
    <h2>Одинокий</h2><p>Вступление.</p>
    <h3>Первая</h3><p>Один.</p>
    <h3>Вторая</h3><p>Два.</p>`);
  assert.deepEqual(result.parts.map((part) => [part.kind, part.title]), [
    ['intro', 'Глава'], ['section', 'Первая'], ['section', 'Вторая'],
  ]);
  assert.equal(result.parts[0].markdown, '# Глава\n\n## Одинокий\n\nВступление.\n');
  assert.equal(result.parts[1].markdown, '## Первая\n\nОдин.\n');
});

test('главы определяются по структуре, а не по слову «Глава»', () => {
  const chapters = buildChapters([
    htmlToBlocks('<body><h2>Вместо предисловия</h2><p>Раз.</p></body>'),
    htmlToBlocks('<body><h2>Глава вторая</h2><p>Два.</p></body>'),
  ]);
  assert.deepEqual(chapters.map((c) => c.title), ['Вместо предисловия', 'Глава вторая']);
});

test('пустые документы пропускаются, нумерация без дыр', () => {
  const chapters = buildChapters([
    htmlToBlocks('<body><img src="cover.jpg"/></body>'),
    htmlToBlocks('<body><p>Один.</p></body>'),
    htmlToBlocks('<body><div> <br/> </div></body>'),
    htmlToBlocks('<body><p>Два.</p></body>'),
  ]);
  const plan = planBook({ metadata: { title: 'К', authors: [], language: '' }, chapters });
  assert.deepEqual(plan.files.map((f) => f.path), ['book.md', 'parts/001.md', 'parts/002.md']);
  assert.match(plan.files[0].content, /^- Автор: не указан$/m);
});

test('документ без заголовка — в оглавлении первые слова', () => {
  const result = chapter('<p>Один два три четыре пять шесть семь восемь девять десять.</p>');
  assert.equal(result.title, 'Один два три четыре пять шесть семь восемь…');
  assert.equal(result.parts[0].markdown, 'Один два три четыре пять шесть семь восемь девять десять.\n');
});

test('пробелы вокруг курсива выносятся за маркеры, неразрывный пробел сохраняется', () => {
  const { blocks } = htmlToBlocks('<body><p>Это<em> важно </em>и&nbsp;точка.</p></body>');
  assert.deepEqual(blocks, [{ type: 'text', text: 'Это *важно* и точка.' }]);
});

test('вертикальная черта в заголовке не ломает таблицу оглавления', () => {
  const chapters = buildChapters([htmlToBlocks('<body><h1>Да | нет</h1><p>Текст.</p></body>')]);
  const plan = planBook({ metadata: { title: 'К', authors: ['А'], language: 'ru' }, chapters });
  assert.match(plan.files[0].content, /^\| 001 \| Да \\\| нет \| parts\/001\.md \| 3 \|$/m);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { wrapText } from '../scripts/build_tutorial.mjs';

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
const graphemes = text => [...segmenter.segment(text)].map(item => item.segment);
const measure = async text => graphemes(text).length;

test('wrapped lines respect the width limit when an emoji contains several code points', async () => {
  const original = '👩‍💻 xxxxx';
  const lines = await wrapText([original], 3, measure, '测试步骤');

  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(await measure(line) <= 3, `overwide line: ${line}`);
  assert.equal(lines.join('').replaceAll(' ', ''), original.replaceAll(' ', ''));
  assert.equal(lines.flatMap(graphemes).filter(char => char === '👩‍💻').length, 1);
});

test('explicit line breaks and empty lines survive wrapping', async () => {
  assert.deepEqual(
    await wrapText(['第一行\r\n\r\n第二行', '第三行'], 20, measure, '测试步骤'),
    ['第一行', '', '第二行', '第三行'],
  );
});

test('a box narrower than one character fails instead of dropping text', async () => {
  await assert.rejects(wrapText(['字'], 0.5, measure, '测试步骤'), /文字框太窄/);
});

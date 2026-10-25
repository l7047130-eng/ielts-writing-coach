import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.IELTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-manual-'));
process.env.WRITING_COACH_CONFIG = path.join(process.env.IELTS_HOME, 'config.json');

const { parseQueueResult } = await import('../lib/manual.js');

const ESSAY = 'Public libraries provide access to useful information. They help students find books and offer quiet places to study. Local governments should continue to support these services.';

const withComments = (over = {}) => ({
  tr: 6.5,
  cc: 6,
  lr: 6,
  ga: 6,
  dims: {
    tr: { comment: '回应完整，停在 6.5 而不是 7。', evidence: ['They help students find books'], fix_example: '' },
    cc: { comment: '推进清楚，衔接偏机械。', evidence: ['Local governments should continue'], fix_example: '' },
    lr: { comment: '词汇够用。', evidence: ['offer quiet places to study'], fix_example: '' },
    ga: { comment: '句子结构单一。', evidence: ['They help students find books'], fix_example: '' },
  },
  strengths: ['立场清楚'],
  weaknesses: ['展开不足'],
  next_actions: ['补例子'],
  ...over,
});

// ---------------------------------------------------------------------------
// 复核：只出四个分数
// ---------------------------------------------------------------------------
test('复核信封 {passB} 能被识别，不再被当成 passA', () => {
  const r = parseQueueResult({ passB: { tr: 6.5, cc: 6, lr: 6, ga: 6 } }, { essay: ESSAY, kind: 'review' });
  assert.equal(r.passA, null);
  assert.deepEqual(r.passB, { tr: 6.5, cc: 6, lr: 6, ga: 6 });
  assert.deepEqual(r.missing, []);
});

test('复核的裸四分数对象也能识别', () => {
  const r = parseQueueResult({ tr: 6.5, cc: 6, lr: 6, ga: 6 }, { essay: ESSAY, kind: 'review' });
  assert.deepEqual(r.passB, { tr: 6.5, cc: 6, lr: 6, ga: 6 });
});

test('复核分数非法时明确拒绝', () => {
  for (const bad of [{ tr: 6.3 }, { tr: '' }, { tr: '-6' }, { tr: '80/100' }, { tr: 12 }]) {
    const r = parseQueueResult({ passB: { tr: 6, cc: 6, lr: 6, ga: 6, ...bad } }, { essay: ESSAY, kind: 'review' });
    assert.equal(r.passB, null, `${JSON.stringify(bad)} 不该通过`);
    assert.ok(r.warnings.join('').length > 0);
  }
});

test('复核缺维度时拒绝', () => {
  const r = parseQueueResult({ passB: { tr: 6.5, cc: 6 } }, { essay: ESSAY, kind: 'review' });
  assert.equal(r.passB, null);
  assert.match(r.warnings.join(' '), /缺少维度/);
});

// ---------------------------------------------------------------------------
// 完整批改
// ---------------------------------------------------------------------------
test('完整信封 + 改写能解析', () => {
  const r = parseQueueResult({
    passA: withComments(),
    revision: 'Public libraries give people access to information.\n\nThey help students find books and offer quiet study spaces.',
  }, { essay: ESSAY, kind: 'full' });
  assert.ok(r.passA);
  assert.equal(r.passA.tr, 6.5);
  assert.ok(r.revision);
});

test('只有四个分数不能当完整批改', () => {
  const r = parseQueueResult({ tr: 6, cc: 6, lr: 6, ga: 6 }, { essay: ESSAY, kind: 'full' });
  assert.equal(r.passA, null);
  assert.match(r.warnings.join(' '), /点评/);
});

test('完整批改里出现 6.3 会被拒', () => {
  const r = parseQueueResult({ passA: withComments({ tr: 6.3 }) }, { essay: ESSAY, kind: 'full' });
  assert.equal(r.passA, null);
  assert.match(r.warnings.join(' '), /0\.5/);
});

test('字符串分数 "6.5" 可以用，"6.5（Band 6.5）" 不行', () => {
  const ok = parseQueueResult({ passA: withComments({ tr: '6.5' }) }, { essay: ESSAY, kind: 'full' });
  assert.equal(ok.passA?.tr, 6.5);
  const no = parseQueueResult({ passA: withComments({ tr: '6.5（Band 6.5）' }) }, { essay: ESSAY, kind: 'full' });
  assert.equal(no.passA, null);
});

test('引用句一条都对不上 → 判为粘错，整份拒收', () => {
  const wrong = withComments();
  for (const k of Object.keys(wrong.dims)) {
    wrong.dims[k].evidence = ['this sentence never appears in the essay at all'];
  }
  const r = parseQueueResult({ passA: wrong }, { essay: ESSAY, kind: 'full' });
  assert.equal(r.passA, null);
  assert.match(r.warnings.join(' '), /不是对当前作文/);
});

test('围栏 + 前后解释文字也能抠出 JSON', () => {
  const text = `好的，下面是结果：\n\n\`\`\`json\n${JSON.stringify({ passA: withComments() })}\n\`\`\`\n\n需要我再解释吗？`;
  const r = parseQueueResult(text, { essay: ESSAY, kind: 'full' });
  assert.ok(r.passA);
});

test('完全不是 JSON 时给出明确提示', () => {
  const r = parseQueueResult('我觉得这篇大概 6 分吧。', { essay: ESSAY, kind: 'full' });
  assert.equal(r.passA, null);
  assert.match(r.warnings.join(' '), /没有找到任何 JSON/);
});

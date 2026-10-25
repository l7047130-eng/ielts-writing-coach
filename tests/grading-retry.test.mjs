import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startMockModel } from './helpers.mjs';

// 假模型先起来，再写临时配置，最后才 import 真实模块（settings 在 import 时读路径）
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-grade-'));
let respond = () => ({ content: 'OK' });

const mock = await startMockModel(() => respond());

const CONFIG = path.join(HOME, 'config.json');
fs.writeFileSync(CONFIG, JSON.stringify({
  mode: 'api',
  base: mock.base,
  key: 'test-key-not-real',
  model: 'mock-model',
}));
process.env.IELTS_HOME = HOME;
process.env.WRITING_COACH_CONFIG = CONFIG;

const { gradePass } = await import('../lib/grading.js');

const ESSAY = 'Public libraries provide access to useful information. They help students find books and offer quiet places to study.';
const baseArgs = { pass: 'A', task: 2, prompt: 'Some people think libraries are unnecessary. Discuss.', essay: ESSAY, wordCount: 26 };

const fullJSON = (over = {}) => JSON.stringify({
  tr: 6.5, cc: 6, lr: 6.5, ga: 6,
  dims: {
    tr: { comment: '回应完整，停在 6.5。', evidence: [], fix_example: '' },
    cc: { comment: '衔接略机械。', evidence: [], fix_example: '' },
    lr: { comment: '词汇够用。', evidence: [], fix_example: '' },
    ga: { comment: '句式偏单一。', evidence: [], fix_example: '' },
  },
  strengths: ['立场清楚'], weaknesses: ['展开不足'], next_actions: ['补例子'],
  ...over,
});

const reset = () => { mock.calls.length = 0; };
const repairCalls = () => mock.calls.filter((c) => JSON.stringify(c.body?.messages || []).includes('JSON 修复器'));

test('只有四个分数：重跑一次后仍不合格就抛错，绝不交给 JSON 修复器补分', async () => {
  reset();
  respond = () => ({ content: JSON.stringify({ tr: 6, cc: 6, lr: 6, ga: 6 }) });
  await assert.rejects(
    () => gradePass({ ...baseArgs }),
    /不合格|点评/,
  );
  assert.equal(mock.calls.length, 2, '应该只重跑一次，不额外请求');
  assert.equal(repairCalls().length, 0, '缺点评/缺分数时不允许调用修复器');
});

test('分数非法（6.3）：重跑一次仍非法就抛错，不修 JSON', async () => {
  reset();
  respond = () => ({ content: fullJSON({ tr: 6.3 }) });
  await assert.rejects(() => gradePass({ ...baseArgs }), /不合格|0\.5/);
  assert.equal(mock.calls.length, 2);
  assert.equal(repairCalls().length, 0);
});

test('JSON 语法坏掉才走修复器，修好之后正常返回', async () => {
  reset();
  let n = 0;
  respond = () => {
    n += 1;
    return n === 1
      ? { content: '好的，这是评分：抱歉输出被截断了' }
      : { content: fullJSON() };
  };
  const r = await gradePass({ ...baseArgs });
  assert.equal(r.data.tr, 6.5);
  assert.equal(mock.calls.length, 2);
  assert.equal(repairCalls().length, 1, '结构问题才允许修一次 JSON');
});

test('修复器也补不出点评时仍然抛错', async () => {
  reset();
  let n = 0;
  respond = () => {
    n += 1;
    return n === 1
      ? { content: 'not json at all' }
      : { content: JSON.stringify({ tr: 6, cc: 6, lr: 6, ga: 6 }) };   // 修复后仍无点评
  };
  await assert.rejects(() => gradePass({ ...baseArgs }), /点评|不合格/);
});

test('输出被截断（finish_reason=length）时加预算重跑，不进修复器', async () => {
  reset();
  let n = 0;
  respond = () => {
    n += 1;
    return n === 1
      ? { content: '{"tr": 6, "cc": 6', finish: 'length' }
      : { content: fullJSON() };
  };
  const r = await gradePass({ ...baseArgs });
  assert.equal(r.overall, 6.5);
  assert.equal(repairCalls().length, 0);
});

test('单次评分的综合分只舍入一次', async () => {
  reset();
  respond = () => ({ content: fullJSON({ tr: 6, cc: 6.5, lr: 6, ga: 5.5 }) });
  const r = await gradePass({ ...baseArgs });
  assert.equal(r.overall, 6);   // (6+6.5+6+5.5)/4 = 6
});

test('清理假模型', async () => {
  await mock.close();
});

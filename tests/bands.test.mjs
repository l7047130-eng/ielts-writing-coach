import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.IELTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-bands-'));
process.env.WRITING_COACH_CONFIG = path.join(process.env.IELTS_HOME, 'config.json');

const {
  DIM_KEYS, isBand, mergePasses, overallOf, toHalf, gradeResultSchema, reviewScoresSchema,
} = await import('../lib/contract.js');
const { toBand, validateGrade, validateReview, combineResults, finalizeResults } = await import('../lib/grading.js');

const full = (over = {}) => ({
  tr: 6, cc: 6, lr: 6, ga: 6,
  dims: {
    tr: { comment: '任务回应完整，停在 6 而不是 6.5。', evidence: [], fix_example: '' },
    cc: { comment: '分段合理，衔接略机械。', evidence: [], fix_example: '' },
    lr: { comment: '词汇够用但重复。', evidence: [], fix_example: '' },
    ga: { comment: '简单句为主，偶有错误。', evidence: [], fix_example: '' },
  },
  ...over,
});

// ---------------------------------------------------------------------------
test('toBand 拒绝所有非法输入', () => {
  const bad = [6.3, '', '  ', '-6', '-0.5', '80/100', '6.5（Band 6.5）', 'Band 6.5', '六分', 9.5, 10, -1, NaN, Infinity, true, {}, [], null, undefined, '6.5.5'];
  for (const v of bad) {
    assert.equal(toBand(v), null, `${JSON.stringify(v)} 应该被拒绝，实际 ${toBand(v)}`);
  }
});

test('toBand 只接受 0–9 的 0.5 步进（数字或严格数字字符串）', () => {
  const ok = [[6, 6], [6.5, 6.5], ['6.5', 6.5], [' 7 ', 7], [0, 0], [9, 9], ['+6', 6], ['0.5', 0.5]];
  for (const [input, expected] of ok) {
    assert.equal(toBand(input), expected, `${JSON.stringify(input)} → ${toBand(input)}`);
  }
});

test('完整批改契约：只有四个分数不算完整批改', () => {
  const r = validateGrade({ tr: 6, cc: 6, lr: 6, ga: 6 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'incomplete');
  assert.match(r.issues, /点评/);
});

test('完整批改契约：合法结果通过', () => {
  const r = validateGrade(full());
  assert.equal(r.ok, true);
  assert.equal(r.data.tr, 6);
});

test('完整批改契约：6.3 / 空串 / -6 / 80 都被拒', () => {
  for (const bad of [{ tr: 6.3 }, { tr: '' }, { tr: '-6' }, { tr: '80' }, { tr: 10 }]) {
    const r = validateGrade(full(bad));
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应该被拒`);
    assert.equal(r.kind, 'invalid-scores', `${JSON.stringify(bad)} 应该判为 invalid-scores，实际 ${r.kind}`);
  }
});

test('复核契约：只认四个合法分数', () => {
  assert.equal(validateReview({ tr: 6.5, cc: 6, lr: 6, ga: 6 }).ok, true);
  const bad = validateReview({ tr: 6.3, cc: 6, lr: 6, ga: 6 });
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, 'invalid-scores');
  assert.equal(validateReview({ tr: 6, cc: 6, lr: 6 }).kind, 'missing-scores');
});

test('schema 层也挡住非半步进', () => {
  assert.equal(gradeResultSchema.safeParse({ ...full(), tr: 6.3 }).success, false);
  assert.equal(reviewScoresSchema.safeParse({ tr: 6.3, cc: 6, lr: 6, ga: 6 }).success, false);
  assert.equal(reviewScoresSchema.safeParse({ tr: 6.5, cc: 6, lr: 6, ga: 6 }).success, true);
});

// ---------------------------------------------------------------------------
test('合并不再重复舍入：先算未舍入均值，只 round 一次', () => {
  const a = { tr: 6, cc: 6, lr: 6, ga: 6 };
  const b = { tr: 6.5, cc: 6.5, lr: 6.5, ga: 6 };
  const { score, raw, pass_overall, spread } = mergePasses(a, b);

  // 未舍入均值：6.25 / 6.25 / 6.25 / 6.0 → 综合 6.1875 → 6.0
  assert.equal(raw.tr, 6.25);
  assert.equal(raw.ga, 6);
  assert.equal(score.overall, 6.0, '按项目约定应该得到 6.0');
  assert.notEqual(score.overall, 6.5, '这是先舍入维度再平均才会出现的值');
  assert.deepEqual(score, { tr: 6.5, cc: 6.5, lr: 6.5, ga: 6, overall: 6 });
  assert.deepEqual(pass_overall, [6, 6.5]);
  assert.equal(spread, 0.5);
});

test('合并后 toHalf 不会改变综合分（不会二次舍入回来）', () => {
  const merged = mergePasses(
    { tr: 6, cc: 6, lr: 6, ga: 6 },
    { tr: 6.5, cc: 6.5, lr: 6.5, ga: 6 },
  );
  assert.equal(toHalf(merged.score.overall), merged.score.overall);
  assert.equal(merged.score.overall, 6.0);
});

test('单评也只在最后 round 一次', () => {
  const r = finalizeResults(full({ tr: 6, cc: 6.5, lr: 6, ga: 5.5 }));
  // 24/4 = 6
  assert.equal(r.score.overall, 6);
  assert.equal(r.spread, null);
  assert.equal(overallOf({ tr: 7, cc: 7, lr: 7, ga: 7 }), 7);
});

test('isBand 边界', () => {
  assert.equal(isBand(0), true);
  assert.equal(isBand(9), true);
  assert.equal(isBand(6.5), true);
  assert.equal(isBand(6.3), false);
  assert.equal(isBand(9.5), false);
});

// ---------------------------------------------------------------------------
test('复核结果分更高时，仍然保留完整批改的点评', () => {
  const a = full({ tr: 6, cc: 6, lr: 6, ga: 6 });
  const b = { tr: 7, cc: 7, lr: 7, ga: 7 };   // 仅分数，没有 dims
  const merged = combineResults(a, b);
  for (const k of DIM_KEYS) {
    assert.ok(merged.dims[k].comment.length > 0, `${k} 的点评被空点评覆盖了`);
  }
  assert.ok(merged.score.overall >= 6.5);
});

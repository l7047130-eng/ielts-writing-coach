import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-status-'));
process.env.IELTS_HOME = HOME;
process.env.WRITING_COACH_CONFIG = path.join(HOME, 'config.json');

const queue = await import('../lib/queue.js');

const Q = (b) => path.join(HOME, 'writing', 'queue', b);
const id = (n) => `20261024_task2_${n}`;

function put(bucket, name, content) {
  fs.mkdirSync(Q(bucket), { recursive: true });
  const f = path.join(Q(bucket), `${name}.json`);
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  return f;
}

const pendingObj = (name) => ({
  id: name,
  kind: 'full',
  created_at: new Date().toISOString(),
  task: 2,
  topic: 'x',
  essay: 'essay body',
});

test('只有 pending → pending', () => {
  const name = id('pending-only');
  put('pending', name, pendingObj(name));
  const st = queue.getStatus(name);
  assert.equal(st.status, 'pending');
  assert.equal(st.resultState, 'absent');
});

test('合法 done → done', () => {
  const name = id('done-ok');
  put('pending', name, pendingObj(name));
  put('done', name, { passA: { tr: 6 } });
  const st = queue.getStatus(name);
  assert.equal(st.status, 'done');
  assert.equal(st.resultState, 'ready');
});

test('done 是半截 JSON 且刚写入 → 先算「正在写」，不判失败', () => {
  const name = id('done-writing');
  put('pending', name, pendingObj(name));
  put('done', name, '{"passA": {"tr": 6');
  const st = queue.getStatus(name);
  assert.equal(st.status, 'pending');
  assert.equal(st.resultState, 'writing');
  assert.ok(st.note);
});

test('done 是坏 JSON 且已过宽容窗口 → 明确 failed，不再假装 done', () => {
  const name = id('done-broken');
  put('pending', name, pendingObj(name));
  const f = put('done', name, '{"passA": ');
  const t = new Date(Date.now() - 60000);
  fs.utimesSync(f, t, t);

  const st = queue.getStatus(name);
  assert.equal(st.status, 'failed');
  assert.equal(st.resultState, 'invalid');
  assert.match(st.failure.reason, /JSON/);
  assert.equal(st.failure.kind, 'invalid-json');
});

test('空 done 文件也算确定失败（超过窗口）', () => {
  const name = id('done-empty');
  put('pending', name, pendingObj(name));
  const f = put('done', name, '   ');
  const t = new Date(Date.now() - 60000);
  fs.utimesSync(f, t, t);
  const st = queue.getStatus(name);
  assert.equal(st.status, 'failed');
});

test('failed 文件存在 → 带原因返回', () => {
  const name = id('failed-flag');
  put('pending', name, pendingObj(name));
  queue.markFailed(name, '缺维度分数：tr / cc', { warnings: ['缺维度分数：tr / cc'] });
  const st = queue.getStatus(name);
  assert.equal(st.status, 'failed');
  assert.match(st.failure.reason, /缺维度/);
});

test('旧 failed 不阻塞新结果：换上合法 done 立刻变 done', () => {
  const name = id('failed-then-fixed');
  put('pending', name, pendingObj(name));
  queue.markFailed(name, '引用的原句一条都对不上');
  assert.equal(queue.getStatus(name).status, 'failed');

  put('done', name, { passA: { tr: 6.5 } });
  const st = queue.getStatus(name);
  assert.equal(st.status, 'done', '旧的 failed 状态不能永久挡住新结果');
});

test('没有 pending 但有导入标记 → imported，带上落盘记录 id', () => {
  const name = id('imported');
  queue.markImported(name, '20261024_task2_imported');
  const st = queue.getStatus(name);
  assert.equal(st.status, 'imported');
  assert.equal(st.assessment_id, '20261024_task2_imported');
});

test('什么都没有 → missing', () => {
  assert.equal(queue.getStatus(id('nothing')).status, 'missing');
});

test('非法 id 直接抛错或用空值短路，绝不落到文件系统', () => {
  assert.throws(() => queue.getStatus('../escape'), /不合法/);
  assert.throws(() => queue.inspectDone('a/b'), /不合法/);
  // 只读函数用 null 短路：调用方本来就要处理「没有这个任务」
  assert.equal(queue.readPending('..\\escape'), null);
  assert.equal(queue.readFailed('a/b'), null);
  assert.equal(queue.readImported('../x'), null);
});

test('listPending 带上恢复等待页需要的字段', () => {
  const name = id('listed');
  put('pending', name, { ...pendingObj(name), instruction: 'x'.repeat(120), kind: 'review', assessment_id: 'a1' });
  const list = queue.listPending();
  const item = list.find((x) => x.id === name);
  assert.ok(item);
  assert.equal(item.chars, 120);
  assert.equal(item.kind, 'review');
  assert.equal(item.assessment_id, 'a1');
  assert.equal(item.has_result, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startServer, startMockModel, fullGrade, ageFile, queueDirs, rawGet } from './helpers.mjs';

// ---------------------------------------------------------------------------
// 全部跑在临时目录 + 假模型上：不碰 ~/.ielts，不调任何付费接口
// ---------------------------------------------------------------------------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-api-'));
const HOME_QUEUE = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-apiq-'));

// 默认让模型一律 400（测错误通路）；打开 gradeMode 后按请求类型返回评分 / 改写
let gradeMode = false;
const mock = await startMockModel((n, body) => {
  if (!gradeMode) return { status: 400, message: 'mock 模型拒绝了这次请求' };
  const isJson = body?.response_format?.type === 'json_object';
  if (isJson) return { content: JSON.stringify(fullGrade()) };
  return {
    content: 'Public libraries open up access to information for everyone. They give students free books and quiet rooms to study in, so cities should keep paying for them.',
  };
});

const cfgApi = path.join(HOME, 'config.json');
fs.writeFileSync(cfgApi, JSON.stringify({
  mode: 'api', base: mock.base, key: 'test-key', model: 'mock-model',
}));
const cfgQueue = path.join(HOME_QUEUE, 'config.json');
fs.writeFileSync(cfgQueue, JSON.stringify({ mode: 'queue' }));

const api = await startServer({ home: HOME, config: cfgApi });
const qmode = await startServer({ home: HOME_QUEUE, config: cfgQueue });
const Q = queueDirs(HOME);

const ESSAY_A = 'Public libraries provide access to useful information. They help students find books and offer quiet places to study. Local governments should continue to support these services.';
const ESSAY_B = 'Public libraries are important because they give free access to knowledge. Many families cannot afford books at home. Cities should keep funding them.';

const post = (body) => api.api('/api/queue', { method: 'POST', body: JSON.stringify(body) });

function writeDone(id, content) {
  fs.mkdirSync(Q.done, { recursive: true });
  const f = path.join(Q.done, `${id}.json`);
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  return f;
}

async function waitDone(id) {
  const r = await api.api(`/api/queue/${id}`);
  assert.equal(r.status, 200, `状态接口返回 ${r.status}`);
  return r.body;
}

test.after(async () => {
  await api.stop();
  await qmode.stop();
  await mock.close();
});

// ---------------------------------------------------------------------------
// 1. 同话题连续 / 并发入队
// ---------------------------------------------------------------------------
test('同一天同话题连续提交两篇：ID 不同，正文都不丢', async () => {
  const a = await post({ task: 2, topic: 'lib-dup', prompt: 'p', essay: ESSAY_A });
  const b = await post({ task: 2, topic: 'lib-dup', prompt: 'p', essay: ESSAY_B });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(a.body.id, b.body.id, '两次拿到了同一个 ID');

  const fa = JSON.parse(fs.readFileSync(path.join(Q.pending, `${a.body.id}.json`), 'utf8'));
  const fb = JSON.parse(fs.readFileSync(path.join(Q.pending, `${b.body.id}.json`), 'utf8'));
  assert.equal(fa.essay, ESSAY_A);
  assert.equal(fb.essay, ESSAY_B, '第二篇覆盖了第一篇的正文');
});

test('并发提交 5 篇：全部拿到不同 ID，pending 一个不少', async () => {
  const essays = ['one', 'two', 'three', 'four', 'five'].map(
    (k) => `${ESSAY_A} marker-${k}`
  );
  const results = await Promise.all(essays.map(
    (essay) => post({ task: 2, topic: 'lib-concurrent', prompt: 'p', essay })
  ));
  const ids = results.map((r) => r.body.id);
  assert.equal(new Set(ids).size, 5, `出现重复 ID：${ids.join(', ')}`);
  for (const [i, id] of ids.entries()) {
    const f = JSON.parse(fs.readFileSync(path.join(Q.pending, `${id}.json`), 'utf8'));
    assert.match(f.essay, new RegExp(`marker-${['one', 'two', 'three', 'four', 'five'][i]}$`));
  }
});

// ---------------------------------------------------------------------------
// 2. 不合格结果的失败 → 修正 → 成功
// ---------------------------------------------------------------------------
test('只有四个分数：ingest 回 422、写 failed、页面看得到原因；换成合法结果后能恢复', async () => {
  const enq = await post({ task: 2, topic: 'only-scores', prompt: 'p', essay: ESSAY_A });
  const id = enq.body.id;

  writeDone(id, { tr: 6, cc: 6, lr: 6, ga: 6 });
  const bad = await api.api(`/api/queue/${id}/ingest`, { method: 'POST' });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.warnings.join(' ').match(/点评/), `warnings 应该说明缺点评：${JSON.stringify(bad.body)}`);
  assert.equal(fs.existsSync(path.join(Q.failed, `${id}.json`)), true);
  assert.equal(fs.existsSync(path.join(HOME, 'writing', 'assessments', id)), false, '不合格的结果不能落盘');

  const st = await waitDone(id);
  assert.equal(st.status, 'failed');
  assert.match(st.failure.reason, /点评/);

  // 换成一份合格的完整批改：旧 failed 不该永久挡住
  const f = writeDone(id, { passA: fullGrade(), revision: null });
  ageFile(f, 10);
  const st2 = await waitDone(id);
  assert.equal(st2.status, 'done');

  const ok = await api.api(`/api/queue/${id}/ingest`, { method: 'POST' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.detail.meta.status, 'COMPLETED');
  assert.equal(ok.body.detail.merged.score.overall, 6.5);
  assert.ok(fs.existsSync(path.join(HOME, 'writing', 'submissions', `${id}.md`)));
});

test('done 文件是坏 JSON：状态回到 failed（超时后），不会再无限显示 done', async () => {
  const enq = await post({ task: 2, topic: 'broken-json', prompt: 'p', essay: ESSAY_A });
  const id = enq.body.id;
  const f = writeDone(id, '{"passA": {"tr": 6,');
  ageFile(f, 30);

  const st = await api.api(`/api/queue/${id}`);
  assert.equal(st.body.status, 'failed');
  assert.equal(st.body.resultState, 'invalid');

  const bad = await api.api(`/api/queue/${id}/ingest`, { method: 'POST' });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /JSON/);

  const fixed = writeDone(id, { passA: fullGrade() });
  ageFile(fixed, 5);
  assert.equal((await api.api(`/api/queue/${id}`)).body.status, 'done');
});

test('引用句全对不上的结果会被拒，且不生成成绩记录', async () => {
  const enq = await post({ task: 2, topic: 'wrong-evidence', prompt: 'p', essay: ESSAY_A });
  const id = enq.body.id;
  const g = fullGrade();
  for (const k of Object.keys(g.dims)) g.dims[k].evidence = ['completely unrelated sentence from another essay'];
  writeDone(id, { passA: g });

  const r = await api.api(`/api/queue/${id}/ingest`, { method: 'POST' });
  assert.equal(r.status, 422);
  assert.match(r.body.warnings.join(' '), /不是对当前作文/);
  assert.equal(fs.existsSync(path.join(HOME, 'writing', 'assessments', id)), false);
});

// ---------------------------------------------------------------------------
// 3. 幂等
// ---------------------------------------------------------------------------
test('两个页面同时 ingest：只落一条记录，第二次返回 already', async () => {
  const enq = await post({ task: 2, topic: 'idempotent', prompt: 'p', essay: ESSAY_A });
  const id = enq.body.id;
  writeDone(id, { passA: fullGrade() });

  const [a, b] = await Promise.all([
    api.api(`/api/queue/${id}/ingest`, { method: 'POST' }),
    api.api(`/api/queue/${id}/ingest`, { method: 'POST' }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const already = [a, b].filter((r) => r.body.already);
  assert.equal(already.length, 1, '应该有一次是幂等返回');

  const subs = fs.readdirSync(path.join(HOME, 'writing', 'submissions'));
  assert.equal(subs.filter((f) => f === `${id}.md`).length, 1);

  // 再打一次还是 200，不会变成 404
  const again = await api.api(`/api/queue/${id}/ingest`, { method: 'POST' });
  assert.equal(again.status, 200);
  assert.equal(again.body.detail.meta.id, id);

  const st = await api.api(`/api/queue/${id}`);
  assert.equal(st.body.status, 'imported');
  assert.equal(st.body.assessment_id, id);
});

// ---------------------------------------------------------------------------
// 4. 复核
// ---------------------------------------------------------------------------
test('复核全流程：材料取存档、保留点评与元数据、能重复复核', async () => {
  const enq = await post({ task: 2, topic: 'review-me', prompt: 'Should libraries be free?', essay: ESSAY_A, duration_min: 38 });
  const id = enq.body.id;
  const grade = fullGrade();
  writeDone(id, { passA: grade, revision: 'Public libraries give people free access to information.\n\nThey help students find books and offer quiet study spaces.' });

  const first = await api.api(`/api/queue/${id}/ingest`, { method: 'POST' });
  assert.equal(first.status, 200);
  const before = first.body.detail;
  const createdBefore = before.meta.created_at;

  // 客户端故意提交被篡改的材料，服务端必须忽略
  const rev = await api.api('/api/queue', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'review',
      id,
      essay: 'THIS IS A TAMPERED ESSAY THAT MUST NOT BE USED',
      prompt: 'tampered prompt',
      task: 1,
    }),
  });
  assert.equal(rev.status, 200);
  assert.notEqual(rev.body.id, id, '复核任务应该有自己的队列 id');
  assert.equal(rev.body.assessment_id, id);

  const pendingReview = JSON.parse(fs.readFileSync(path.join(Q.pending, `${rev.body.id}.json`), 'utf8'));
  assert.equal(pendingReview.kind, 'review');
  assert.equal(pendingReview.essay, ESSAY_A, '复核必须用存档原文，不接受客户端重交');
  assert.equal(pendingReview.task, 2);

  // 按复核提示词返回 passB
  const f = writeDone(rev.body.id, { passB: { tr: 7, cc: 7, lr: 7, ga: 7 } });
  ageFile(f, 5);
  const ingested = await api.api(`/api/queue/${rev.body.id}/ingest`, { method: 'POST' });
  assert.equal(ingested.status, 200);
  const after = ingested.body.detail;

  assert.equal(after.meta.created_at, createdBefore, '复核不能改动创建时间');
  assert.equal(after.original, ESSAY_A, '复核不能改动原文');
  assert.ok(after.revised && after.revised.length > 0, '复核不能清掉已有的改写稿');
  assert.equal(after.meta.duration_min, 38, '复核不能丢掉用时');
  assert.equal(after.meta.review_count, 1);

  // 第二次评分更高，但点评必须保留完整批改那一份
  assert.equal(after.merged.pass_overall.length, 2);
  assert.deepEqual(after.merged.pass_overall, [6.5, 7]);
  for (const k of ['tr', 'cc', 'lr', 'ga']) {
    assert.ok(after.merged.dims[k].comment.length > 0, `${k} 的点评被空点评覆盖了`);
  }
  // 只 round 一次：均值 6.75/6.5/6.75/6.5 → 6.625 → 6.5
  assert.equal(after.merged.score.overall, 6.5);
  assert.equal(after.merged.spread, 0.5);
  assert.equal(after.merged.boundary, true);

  // 会话记录仍在（没有对话时是空数组，但不能报错）
  assert.ok(Array.isArray(after.chat));

  // 再复核一次，两个 queue id 不冲突
  const rev2 = await api.api('/api/queue', { method: 'POST', body: JSON.stringify({ kind: 'review', id }) });
  assert.equal(rev2.status, 200);
  assert.notEqual(rev2.body.id, rev.body.id);
});

test('复核结果不是四个分数时回 422 并留下失败原因', async () => {
  const enq = await post({ task: 2, topic: 'review-bad', prompt: 'p', essay: ESSAY_A });
  const id = enq.body.id;
  writeDone(id, { passA: fullGrade() });
  await api.api(`/api/queue/${id}/ingest`, { method: 'POST' });

  const rev = await api.api('/api/queue', { method: 'POST', body: JSON.stringify({ kind: 'review', id }) });
  writeDone(rev.body.id, { passA: fullGrade() });   // 给的是完整批改，不是四个分数
  const bad = await api.api(`/api/queue/${rev.body.id}/ingest`, { method: 'POST' });
  assert.equal(bad.status, 422);
  const st = await api.api(`/api/queue/${rev.body.id}`);
  assert.equal(st.body.status, 'failed');
});

test('复核 id 不存在 / 不合法都会被挡', async () => {
  const r1 = await api.api('/api/queue', { method: 'POST', body: JSON.stringify({ kind: 'review', id: 'nope-not-here' }) });
  assert.equal(r1.status, 404);

  const r2 = await api.api('/api/queue', {
    method: 'POST',
    body: JSON.stringify({ kind: 'review', id: '..\\..\\evil' }),
  });
  assert.equal(r2.status, 400);
  assert.equal(fs.existsSync(path.join(HOME, 'writing', 'queue', 'evil.json')), false);
});

// ---------------------------------------------------------------------------
// 5. 路径边界
// ---------------------------------------------------------------------------
test('队列接口的 ..\\ id 被拒，且不会写出目录', async () => {
  const sentinel = path.join(HOME, 'writing', 'queue', 'sentinel.json');
  fs.writeFileSync(sentinel, '{"keep":true}');

  const r = await fetch(`${api.base}/api/queue/${encodeURIComponent('..\\sentinel')}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 400);

  const r2 = await fetch(`${api.base}/api/assessments/${encodeURIComponent('..\\..\\passwd')}`);
  assert.equal(r2.status, 400);

  assert.equal(JSON.parse(fs.readFileSync(sentinel, 'utf8')).keep, true);
});

// ---------------------------------------------------------------------------
// 6. CORS
// ---------------------------------------------------------------------------
test('伪装成 localhost 的来源被 403，真实本地来源放行', async () => {
  const bad = await fetch(`${api.base}/api/health`, { headers: { Origin: 'https://localhost.attacker.example' } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);

  const ok = await fetch(`${api.base}/api/health`, { headers: { Origin: 'http://localhost:5273' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5273');

  // 预检也一样
  const pre = await fetch(`${api.base}/api/queue`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://localhost.attacker.example',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(pre.status, 403);
});

// ---------------------------------------------------------------------------
// 7. SSE 错误不再被吞
// ---------------------------------------------------------------------------
async function readSSE(res) {
  const events = [];
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = 'message';
      const data = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      let d;
      try { d = JSON.parse(data.join('\n')); } catch { d = data.join('\n'); }
      events.push({ event: ev, data: d });
    }
  }
  return events;
}

test('对话接口：模型 400 时前端能收到 error 事件和明确的 done 状态', async () => {
  const enq = await post({ task: 2, topic: 'chat-err', prompt: 'p', essay: ESSAY_A });
  const id = enq.body.id;
  writeDone(id, { passA: fullGrade() });
  await api.api(`/api/queue/${id}/ingest`, { method: 'POST' });

  const res = await fetch(`${api.base}/api/assessments/${id}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Why is the score six?' }),
  });
  assert.equal(res.status, 200);
  const events = await readSSE(res);
  const err = events.find((e) => e.event === 'error');
  const done = events.find((e) => e.event === 'done');
  assert.ok(err, '必须发 error 事件');
  assert.match(String(err.data.message), /400|mock/);
  assert.ok(done, '必须发 done 收尾');
  assert.equal(done.data.ok, false);
});

test('队列模式下 chat / revise 明确拒绝，不静默直连', async () => {
  const enq = await qmode.api('/api/queue', {
    method: 'POST',
    body: JSON.stringify({ task: 2, topic: 'qmode', prompt: 'p', essay: ESSAY_A }),
  });
  const id = enq.body.id;
  writeDoneFor(HOME_QUEUE, id, { passA: fullGrade() });
  await qmode.api(`/api/queue/${id}/ingest`, { method: 'POST' });

  const chat = await qmode.api(`/api/assessments/${id}/chat`, {
    method: 'POST',
    body: JSON.stringify({ question: 'hi' }),
  });
  assert.equal(chat.status, 409);
  assert.match(chat.body.error, /文件队列模式/);

  const revise = await qmode.api(`/api/assessments/${id}/revise`, { method: 'POST', body: '{}' });
  assert.equal(revise.status, 409);
});

function writeDoneFor(home, id, content) {
  const d = path.join(home, 'writing', 'queue', 'done');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${id}.json`), JSON.stringify(content));
}

// ---------------------------------------------------------------------------
// 9. API 直连模式：SSE 全流程
// ---------------------------------------------------------------------------
test('API 模式 /api/grade：双评 + 改写 + 落盘，SSE 事件齐全', async () => {
  gradeMode = true;
  const res = await fetch(`${api.base}/api/grade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 2, topic: 'api-flow', prompt: 'p', essay: ESSAY_A, duration_min: 33 }),
  });
  assert.equal(res.status, 200);
  const events = await readSSE(res);
  gradeMode = false;

  const names = events.map((e) => e.event);
  assert.ok(names.includes('start'), '缺少 start');
  assert.ok(names.includes('merged'), '缺少 merged');
  assert.ok(names.includes('revision'), '缺少 revision');
  const done = events.find((e) => e.event === 'done');
  assert.equal(done.data.status, 'COMPLETED');
  assert.equal(names.filter((n) => n === 'error').length, 0, `不该有 error：${JSON.stringify(events.filter((e) => e.event === 'error'))}`);

  const id = events.find((e) => e.event === 'start').data.id;
  const detail = await api.api(`/api/assessments/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.meta.status, 'COMPLETED');
  assert.equal(detail.body.merged.pass_overall.length, 2);
  // fullGrade 的四维是 6.5/6/6.5/6，两次一样 → 均值 6.25 → 半分制 6.5
  assert.equal(detail.body.merged.score.overall, 6.5);
  assert.equal(detail.body.merged.spread, 0);
  assert.ok(detail.body.revised && detail.body.revised.length > 0);
  assert.equal(detail.body.meta.duration_min, 33);

  // 契约文件同样要能被老看板读
  const fm = fs.readFileSync(path.join(HOME, 'writing', 'submissions', detail.body.meta.submission_file), 'utf8');
  assert.match(fm, /overall: 6\.5/);
});

test('API 模式模型 500：只留原文，不写 submissions，并明确报错', async () => {
  gradeMode = false;   // 假模型一律 400
  const res = await fetch(`${api.base}/api/grade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 2, topic: 'api-fail', prompt: 'p', essay: ESSAY_B }),
  });
  const events = await readSSE(res);
  const err = events.find((e) => e.event === 'error');
  const done = events.find((e) => e.event === 'done');
  assert.ok(err, '必须发 error');
  assert.equal(done.data.status, 'FAILED');

  const id = events.find((e) => e.event === 'start').data.id;
  const detail = await api.api(`/api/assessments/${id}`);
  assert.equal(detail.body.meta.status, 'FAILED');
  assert.equal(fs.existsSync(path.join(HOME, 'writing', 'submissions', `${id}.md`)), false, '失败不能写进看板');
});

// ---------------------------------------------------------------------------
// 8. 队列恢复入口的数据
// ---------------------------------------------------------------------------
test('GET /api/queue 给出恢复等待页需要的字段', async () => {
  const enq = await post({ task: 2, topic: 'resume', prompt: 'p', essay: ESSAY_A });
  const list = await api.api('/api/queue');
  const item = list.body.items.find((x) => x.id === enq.body.id);
  assert.ok(item, '待处理列表里应该有它');
  assert.equal(item.kind, 'full');
  assert.ok(item.chars > 0);
  assert.equal(item.has_result, false);
  assert.ok(list.body.trigger);
});

// ---------------------------------------------------------------------------
// 10. 中文话题（slugify 保留中文，校验规则必须跟上）
// ---------------------------------------------------------------------------
test('中文话题可以入队，ID 含中文且连续提交不撞号', async () => {
  const a = await post({ task: 2, topic: '公共图书馆', prompt: 'p', essay: ESSAY_A });
  const b = await post({ task: 2, topic: '公共图书馆', prompt: 'p', essay: ESSAY_B });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.match(a.body.id, /公共图书馆/);
  assert.notEqual(a.body.id, b.body.id, '中文话题连交两篇拿到了同一个 ID');

  const fa = JSON.parse(fs.readFileSync(path.join(Q.pending, `${a.body.id}.json`), 'utf8'));
  const fb = JSON.parse(fs.readFileSync(path.join(Q.pending, `${b.body.id}.json`), 'utf8'));
  assert.equal(fa.essay, ESSAY_A);
  assert.equal(fb.essay, ESSAY_B, '第二篇覆盖了第一篇正文');

  // 中英混合也一样
  const mix = await post({ task: 2, topic: '雅思 Task2 写作', prompt: 'p', essay: ESSAY_A });
  assert.equal(mix.status, 200);
  assert.match(mix.body.id, /雅思|task2/i);
});

test('中文话题走 API 直连批改也正常（SSE + 落盘）', async () => {
  gradeMode = true;
  const res = await fetch(`${api.base}/api/grade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 2, topic: '大学教育 should be free', prompt: 'p', essay: ESSAY_A }),
  });
  assert.equal(res.status, 200);
  const events = await readSSE(res);
  gradeMode = false;

  const start = events.find((e) => e.event === 'start');
  assert.ok(start, '缺少 start');
  assert.match(start.data.id, /大学教育/);
  const done = events.find((e) => e.event === 'done');
  assert.equal(done.data.status, 'COMPLETED');

  const detail = await api.api(`/api/assessments/${start.data.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.meta.topic, '大学教育 should be free');
  assert.equal(detail.body.meta.status, 'COMPLETED');
});

test('中文 ID 的旧记录在 HTTP 层也能列出、读取、复核', async () => {
  const cnId = '20261023_task2_公共图书馆';
  const dir = path.join(HOME, 'writing', 'assessments', cnId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id: cnId, created_at: '2026-10-23T00:00:00.000Z', date: '2026-10-23', task: 2,
    topic: '公共图书馆', status: 'COMPLETED', source: 'queue',
    score: { tr: 6.5, cc: 6, lr: 6, ga: 6, overall: 6 }, pass_overall: [6],
  }));
  fs.writeFileSync(path.join(dir, 'original.md'), ESSAY_A);
  fs.writeFileSync(path.join(dir, 'merged.json'), JSON.stringify({
    score: { tr: 6.5, cc: 6, lr: 6, ga: 6, overall: 6 }, pass_overall: [6],
    spread: null, boundary: false, errors: [],
    dims: { tr: { comment: '旧中文记录的点评', evidence: [], fix_example: '' } },
  }));
  fs.writeFileSync(path.join(dir, 'passes.json'), JSON.stringify({
    a: { data: { tr: 6.5, cc: 6, lr: 6, ga: 6 }, overall: 6 },
  }));
  fs.mkdirSync(path.join(HOME, 'writing', 'submissions'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'writing', 'submissions', `${cnId}.md`), '---\ndate: 2026-10-23\n---\n');

  const list = await api.api('/api/assessments');
  assert.ok(list.body.items.some((x) => x.id === cnId), '列表里没有中文 ID 记录');

  const detail = await api.api(`/api/assessments/${cnId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.meta.topic, '公共图书馆');

  // 对中文 ID 发起复核
  const rev = await api.api('/api/queue', {
    method: 'POST',
    body: JSON.stringify({ kind: 'review', id: cnId }),
  });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  assert.match(rev.body.id, /公共图书馆/);
  const pendingReview = JSON.parse(fs.readFileSync(path.join(Q.pending, `${rev.body.id}.json`), 'utf8'));
  assert.equal(pendingReview.kind, 'review');
  assert.equal(pendingReview.assessment_id, cnId);

  const f = writeDone(rev.body.id, { passB: { tr: 7, cc: 7, lr: 7, ga: 7 } });
  ageFile(f, 5);
  const ingested = await api.api(`/api/queue/${rev.body.id}/ingest`, { method: 'POST' });
  assert.equal(ingested.status, 200, JSON.stringify(ingested.body));
  assert.equal(ingested.body.detail.original, ESSAY_A, '复核不能改原文');
  assert.equal(ingested.body.detail.merged.pass_overall.length, 2);
});

// ---------------------------------------------------------------------------
// 11. 图片来源边界
// ---------------------------------------------------------------------------
test('body.imagePath 被拒绝，队列目录外的哨兵文件不会被复制', async () => {
  const sentinel = path.join(HOME, 'private-sentinel.txt');
  fs.writeFileSync(sentinel, 'SECRET-DO-NOT-COPY');

  const r = await post({
    task: 2,
    topic: 'evil-image',
    prompt: 'p',
    essay: ESSAY_A,
    imagePath: sentinel,
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /imagePath/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'SECRET-DO-NOT-COPY');

  // 也不能绕道 pending.image_path → ingest 复制
  const enq = await post({ task: 2, topic: 'evil-image-2', prompt: 'p', essay: ESSAY_A });
  const id = enq.body.id;
  // 手工篡改 pending，把 image_path 指到哨兵文件
  const pf = path.join(Q.pending, `${id}.json`);
  const p = JSON.parse(fs.readFileSync(pf, 'utf8'));
  p.image_path = sentinel;
  fs.writeFileSync(pf, JSON.stringify(p));
  writeDone(id, { passA: fullGrade() });

  const ing = await api.api(`/api/queue/${id}/ingest`, { method: 'POST' });
  assert.equal(ing.status, 400, `不该成功落盘：${JSON.stringify(ing.body)}`);
  assert.match(ing.body.error, /来源目录不合法|图片类型/);
  const asmDir = path.join(HOME, 'writing', 'assessments', id);
  const copied = fs.existsSync(asmDir) ? fs.readdirSync(asmDir) : [];
  assert.equal(copied.some((f) => f.startsWith('image')), false, `复制了不该复制的文件：${copied}`);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'SECRET-DO-NOT-COPY');
});

test('正常上传走 imageBase64：附件落 attachments，导入后复制进评估目录', async () => {
  const TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const enq = await post({
    task: 1,
    topic: 't1-chart',
    prompt: 'The chart below shows...',
    essay: ESSAY_A,
    imageBase64: TINY,
  });
  assert.equal(enq.status, 200);
  const id = enq.body.id;
  const pending = JSON.parse(fs.readFileSync(path.join(Q.pending, `${id}.json`), 'utf8'));
  assert.ok(pending.image_path, '任务里该带图片路径');
  assert.match(pending.image_path.replace(/\\/g, '/'), /queue\/attachments\//);
  assert.ok(fs.existsSync(pending.image_path));

  writeDone(id, { passA: fullGrade() });
  const ing = await api.api(`/api/queue/${id}/ingest`, { method: 'POST' });
  assert.equal(ing.status, 200, JSON.stringify(ing.body));
  assert.ok(fs.existsSync(path.join(HOME, 'writing', 'assessments', id, 'image.png')), '图片应复制进评估目录');

  // 复核沿用存档图片
  const rev = await api.api('/api/queue', { method: 'POST', body: JSON.stringify({ kind: 'review', id }) });
  assert.equal(rev.status, 200);
  const rp = JSON.parse(fs.readFileSync(path.join(Q.pending, `${rev.body.id}.json`), 'utf8'));
  assert.equal(rp.image_path, path.join(HOME, 'writing', 'assessments', id, 'image.png'));
  assert.ok(fs.existsSync(rp.image_path), '复核任务引用的图片必须存在');

  // 图片类型白名单：非图片 mime 直接拒
  const bad = await post({ task: 1, topic: 't1-bad', prompt: 'p', essay: ESSAY_A, imageBase64: 'data:text/plain;base64,aGVsbG8=' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /图片类型/);
});

// ---------------------------------------------------------------------------
// 12. Host 伪造（原生 HTTP 请求，不依赖 fetch 对 Host 的处理）
// ---------------------------------------------------------------------------
test('伪造 Host + 自证 Origin 被拒绝；可信 Host 的同源照常放行', async () => {
  const port = Number(new URL(api.base).port);

  // 复现攻击：Host 和 Origin 都自证为 attacker.example
  const evil = await rawGet(port, '/api/health', {
    Host: 'attacker.example',
    Origin: 'http://attacker.example',
  });
  assert.equal(evil.status, 403, `伪造 Host 不该被放行，实际 ${evil.status}`);
  assert.equal(evil.headers['access-control-allow-origin'], undefined, '不该回 ACAO');

  // 只有 Host 伪造、没有 Origin 也一样拒（DNS rebinding 同理）
  const evilHost = await rawGet(port, '/api/health', { Host: 'attacker.example' });
  assert.equal(evilHost.status, 403);

  // 可信 Host + 自证同源（换过 PORT 的本地页面就是这个形态）→ 放行
  const self = await rawGet(port, '/api/health', {
    Host: `127.0.0.1:${port}`,
    Origin: `http://127.0.0.1:${port}`,
  });
  assert.equal(self.status, 200);
  assert.equal(self.headers['access-control-allow-origin'], `http://127.0.0.1:${port}`);

  // 白名单来源照常放行
  const listed = await rawGet(port, '/api/health', {
    Host: `127.0.0.1:${port}`,
    Origin: 'http://localhost:5273',
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers['access-control-allow-origin'], 'http://localhost:5273');
});

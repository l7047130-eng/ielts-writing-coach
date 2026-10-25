import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startServer, fullGrade, ageFile, queueDirs } from './helpers.mjs';

// ---------------------------------------------------------------------------
// 「导入失败却提前发布正式成绩」
//
// 复现：pending.image_path 指到队列外 → ingest 返回 400，但 submissions/<id>.md
// 已经写了分数，assessments/<id>/ 只剩 original.md（详情 404）。
//
// 每个场景都要同时证明四件事：
//   ① 接口明确失败  ② 没有新增正式成绩  ③ 没有可被误认为成功的半成品
//   ④ 失败原因可见、修正后重试能成功，且最后只有一条完整记录
// ---------------------------------------------------------------------------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-persist-'));
const CONFIG = path.join(HOME, 'config.json');
fs.writeFileSync(CONFIG, JSON.stringify({ mode: 'queue' }));
// 本进程里的 lib 也必须指向临时目录：漏了这一行，落盘会写到真实的 ~/.ielts
process.env.IELTS_HOME = HOME;
process.env.WRITING_COACH_CONFIG = CONFIG;

const server = await startServer({ home: HOME, config: CONFIG });
const Q = queueDirs(HOME);
const SUB = path.join(HOME, 'writing', 'submissions');
const ASM = path.join(HOME, 'writing', 'assessments');
const STAGING = path.join(ASM, '.staging');

const ESSAY = 'Public libraries provide access to useful information. They help students find books and offer quiet places to study. Local governments should continue to support these services.';

// 1x1 红色 PNG
const PNG_B64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const post = (body) => server.api('/api/queue', { method: 'POST', body: JSON.stringify(body) });
const ingest = (id) => server.api(`/api/queue/${id}/ingest`, { method: 'POST' });
const status = (id) => server.api(`/api/queue/${id}`);

const subPath = (id) => path.join(SUB, `${id}.md`);
const dirPath = (id) => path.join(ASM, id);
const pendingPath = (id) => path.join(Q.pending, `${id}.json`);

function writeDone(id, obj) {
  fs.mkdirSync(Q.done, { recursive: true });
  const f = path.join(Q.done, `${id}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  ageFile(f, 5);
  return f;
}

function patchPending(id, patch) {
  const p = JSON.parse(fs.readFileSync(pendingPath(id), 'utf8'));
  fs.writeFileSync(pendingPath(id), JSON.stringify({ ...p, ...patch }));
}

function dirSnapshot(id) {
  const d = dirPath(id);
  if (!fs.existsSync(d)) return null;
  const out = {};
  for (const name of fs.readdirSync(d).sort()) {
    out[name] = fs.readFileSync(path.join(d, name), 'utf8');
  }
  return out;
}

function stagingLeft(id) {
  if (!fs.existsSync(STAGING)) return [];
  return fs.readdirSync(STAGING).filter((n) => n.startsWith(id));
}

/** ②③：没有正式成绩、没有半成品 */
function assertNothingPublished(id) {
  assert.equal(fs.existsSync(subPath(id)), false, `不该新增正式成绩：${id}`);
  assert.equal(fs.existsSync(dirPath(id)), false, `不该留下记录目录：${id}`);
  assert.deepEqual(stagingLeft(id), [], `不该留下暂存残留：${stagingLeft(id).join(', ')}`);
}

/** ④：最后只有一条完整记录 */
async function assertOneCompleteRecord(id) {
  const subs = fs.readdirSync(SUB).filter((f) => f.endsWith('.md'));
  assert.equal(subs.filter((f) => f === `${id}.md`).length, 1, `正式成绩应该恰好一条：${subs.join(', ')}`);
  const detail = await server.api(`/api/assessments/${id}`);
  assert.equal(detail.status, 200, `详情读不出来：${JSON.stringify(detail.body)}`);
  assert.equal(detail.body.meta.status, 'COMPLETED');
  assert.ok(detail.body.meta.submission_file);
  assert.ok(detail.body.merged?.score?.overall != null);
  assert.ok(detail.body.original);
  const meta = JSON.parse(fs.readFileSync(path.join(dirPath(id), 'meta.json'), 'utf8'));
  assert.equal(meta.id, id);
  assert.deepEqual(stagingLeft(id), [], '成功后不该留暂存残留');
}

test.after(async () => {
  await server.stop();
});

// ---------------------------------------------------------------------------
// 1. 图片来源越界
// ---------------------------------------------------------------------------
test('图片来源越界：400，不写正式成绩，修正后重试成功', async () => {
  const sentinel = path.join(HOME, 'private-sentinel.txt');
  fs.writeFileSync(sentinel, 'SECRET-DO-NOT-COPY');

  const enq = await post({ task: 2, topic: 'img-outside', prompt: 'p', essay: ESSAY });
  assert.equal(enq.status, 200, JSON.stringify(enq.body));
  const id = enq.body.id;

  patchPending(id, { image_path: sentinel });
  writeDone(id, { passA: fullGrade(), revision: null });

  const bad = await ingest(id);
  assert.equal(bad.status, 400, `应该明确失败，实际 ${bad.status} ${JSON.stringify(bad.body)}`);
  assert.match(bad.body.error, /来源目录不合法/);

  assertNothingPublished(id);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'SECRET-DO-NOT-COPY', '哨兵文件被动了');

  // 失败原因可见，且不再报 done
  const st = await status(id);
  assert.equal(st.body.status, 'failed');
  assert.match(st.body.failure.reason, /来源目录不合法/);

  // 修正材料：换成 attachments 里的合法图片
  fs.mkdirSync(Q.attachments, { recursive: true });
  const good = path.join(Q.attachments, `${id}.png`);
  fs.writeFileSync(good, Buffer.from('89504e470d0a1a0a', 'hex'));
  patchPending(id, { image_path: good });

  const ok = await ingest(id);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await assertOneCompleteRecord(id);
  assert.ok(fs.existsSync(path.join(dirPath(id), 'image.png')), '合法图片应该被复制进记录目录');
});

// ---------------------------------------------------------------------------
// 2. 合法附件目录中的图片已经不存在
// ---------------------------------------------------------------------------
test('附件目录里的图片已不存在：400，不写正式成绩，补上文件后重试成功', async () => {
  const enq = await post({ task: 2, topic: 'img-missing', prompt: 'p', essay: ESSAY });
  const id = enq.body.id;

  const ghost = path.join(Q.attachments, `${id}.png`);
  patchPending(id, { image_path: ghost });     // 指向 attachments，但文件不存在
  writeDone(id, { passA: fullGrade() });

  const bad = await ingest(id);
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(bad.body.error, /不存在|无法访问/);
  assertNothingPublished(id);

  const st = await status(id);
  assert.equal(st.body.status, 'failed');
  assert.match(st.body.failure.reason, /不存在|无法访问/);

  // 补上图片再试
  fs.mkdirSync(Q.attachments, { recursive: true });
  fs.writeFileSync(ghost, Buffer.from('89504e470d0a1a0a', 'hex'));
  const ok = await ingest(id);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await assertOneCompleteRecord(id);
});

// ---------------------------------------------------------------------------
// 3. 图片类型不支持
// ---------------------------------------------------------------------------
test('图片类型不支持：400，不写正式成绩，换成 png 后重试成功', async () => {
  const enq = await post({ task: 2, topic: 'img-badtype', prompt: 'p', essay: ESSAY });
  const id = enq.body.id;

  fs.mkdirSync(Q.attachments, { recursive: true });
  const txt = path.join(Q.attachments, `${id}.txt`);
  fs.writeFileSync(txt, 'not an image');
  patchPending(id, { image_path: txt });
  writeDone(id, { passA: fullGrade() });

  const bad = await ingest(id);
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(bad.body.error, /图片类型不支持/);
  assertNothingPublished(id);
  assert.equal(fs.readFileSync(txt, 'utf8'), 'not an image');

  const st = await status(id);
  assert.equal(st.body.status, 'failed');

  const png = path.join(Q.attachments, `${id}.png`);
  fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  patchPending(id, { image_path: png });
  const ok = await ingest(id);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await assertOneCompleteRecord(id);
});

// ---------------------------------------------------------------------------
// 4. 图片复制失败（进程内注入 I/O 错误）
//    走持久化层：server 用 fail() 把 PersistError.status 原样映射成 HTTP 状态。
// ---------------------------------------------------------------------------
test('图片复制失败：抛 EPERSIST_IMAGE_COPY，零痕迹，恢复后重试成功', async () => {
  const { persistAssessment, PersistError } = await import('../lib/persist.js');
  const { finalizeResults } = await import('../lib/grading.js');
  const { reserveId } = await import('../lib/ids.js');

  const id = reserveId(2, 'copy-fail');
  fs.mkdirSync(Q.attachments, { recursive: true });
  const src = path.join(Q.attachments, `${id}.png`);
  fs.writeFileSync(src, Buffer.from('89504e470d0a1a0a', 'hex'));

  const grade = fullGrade();
  const merged = finalizeResults(grade);
  const args = {
    id,
    task: 2,
    topic: 'copy-fail',
    prompt: 'p',
    essay: ESSAY,
    imagePath: src,
    wordCount: 26,
    merged,
    passes: { a: { data: grade, overall: merged.score.overall } },
    revision: null,
    source: 'queue',
  };

  const realCopy = fs.copyFileSync;
  let err = null;
  fs.copyFileSync = (from, to, ...rest) => {
    if (String(from).includes('attachments')) {
      const e = new Error('EBUSY: resource busy or locked（模拟复制失败）');
      e.code = 'EBUSY';
      throw e;
    }
    return realCopy(from, to, ...rest);
  };
  try {
    persistAssessment(args);
    assert.fail('复制失败时不该成功返回');
  } catch (e) {
    err = e;
  } finally {
    fs.copyFileSync = realCopy;
  }

  assert.ok(err instanceof PersistError, `应该抛 PersistError，实际 ${err?.name}: ${err?.message}`);
  assert.equal(err.code, 'EPERSIST_IMAGE_COPY');
  assert.equal(err.status, 500);
  assert.match(err.message, /图片复制失败/);
  assertNothingPublished(id);

  // 恢复后重试
  const out = persistAssessment(args);
  assert.equal(out.id, id);
  await assertOneCompleteRecord(id);
});

// ---------------------------------------------------------------------------
// 5. 已有记录更新失败：旧成绩、原文、改写、图片、对话必须逐字节不变
// ---------------------------------------------------------------------------
test('更新已有记录失败：整体回滚，旧记录逐字节不变，重试后只有一条完整记录', async () => {
  const { persistAssessment, PersistError } = await import('../lib/persist.js');
  const { finalizeResults } = await import('../lib/grading.js');
  const store = await import('../lib/store.js');

  // 先正常落一条完整记录（带改写和对话）
  const enq = await post({ task: 1, topic: 'update-guard', prompt: 'chart', essay: ESSAY, imageBase64: PNG_B64 });
  const id = enq.body.id;
  writeDone(id, {
    passA: fullGrade(),
    revision: 'Public libraries open up access to information for everyone.\n\nThey give students free books and quiet rooms to study in.',
  });
  const first = await ingest(id);
  assert.equal(first.status, 200, JSON.stringify(first.body));

  store.appendChat(id, { role: 'user', content: '第二段为什么只有 6 分', at: new Date().toISOString() });
  store.appendChat(id, { role: 'assistant', content: '因为论证没有延展。', at: new Date().toISOString() });

  const before = dirSnapshot(id);
  const subBefore = fs.readFileSync(subPath(id), 'utf8');
  assert.ok(before['revised.md'], '前置条件：改写稿存在');
  assert.ok(before['chat.jsonl'], '前置条件：对话存在');
  assert.ok(before['image.png'], '前置条件：图片存在');

  // 复核语义：新增第二份评分，不传改写/图片
  const reviewGrade = { ...fullGrade(), tr: 7, cc: 7, lr: 7, ga: 7 };
  const merged = finalizeResults(reviewGrade);
  const args = {
    id,
    task: 1,
    topic: 'update-guard',
    prompt: 'chart',
    essay: ESSAY,
    wordCount: 26,
    merged,
    passes: { a: { data: fullGrade() }, b: { data: reviewGrade, overall: merged.score.overall } },
    revision: null,
    source: 'queue',
    createdAt: JSON.parse(before['meta.json']).created_at,
    date: JSON.parse(before['meta.json']).date,
    metaExtra: { reviewed_at: new Date().toISOString(), review_count: 1 },
  };

  // 让「换上新目录」这一步失败（备份已经做完，必须能回滚）
  const realRename = fs.renameSync;
  fs.renameSync = (from, to, ...rest) => {
    if (String(from).includes('.staging') && !String(from).includes('.bak-') && String(to) === dirPath(id)) {
      const e = new Error('EPERM: operation not permitted（模拟发布失败）');
      e.code = 'EPERM';
      throw e;
    }
    return realRename(from, to, ...rest);
  };
  let err = null;
  try {
    persistAssessment(args);
    assert.fail('发布失败时不该成功返回');
  } catch (e) {
    err = e;
  } finally {
    fs.renameSync = realRename;
  }

  assert.ok(err instanceof PersistError, `应该抛 PersistError，实际 ${err?.name}: ${err?.message}`);
  assert.equal(err.code, 'EPERSIST_PUBLISH');
  assert.equal(err.status, 500);
  assert.match(err.message, /已回滚/);

  // 旧记录逐字节不变
  assert.deepEqual(dirSnapshot(id), before, '更新失败后记录目录被改动了');
  assert.equal(fs.readFileSync(subPath(id), 'utf8'), subBefore, '更新失败后正式成绩被改动了');
  assert.deepEqual(stagingLeft(id), [], '不该留下暂存/备份残留');

  // 重试（不注入错误）→ 成功，且只有一条记录，原有内容保留
  const out = persistAssessment(args);
  assert.equal(out.id, id);
  await assertOneCompleteRecord(id);
  const after = dirSnapshot(id);
  assert.ok(after['revised.md'], '更新把改写稿弄丢了');
  assert.ok(after['chat.jsonl'], '更新把对话弄丢了');
  assert.ok(after['image.png'], '更新把图片弄丢了');
  assert.match(after['chat.jsonl'], /第二段为什么只有 6 分/);
  const meta = JSON.parse(after['meta.json']);
  assert.equal(meta.review_count, 1);
  assert.equal(meta.created_at, JSON.parse(before['meta.json']).created_at, '复核不该改创建时间');
});

// ---------------------------------------------------------------------------
// 5b. 接口面：复核前置校验失败时，旧记录同样原样不动
// ---------------------------------------------------------------------------
test('复核缺原始评分：接口 409，旧成绩与原文不变，队列不是 done', async () => {
  const enq = await post({ task: 2, topic: 'review-guard', prompt: 'p', essay: ESSAY });
  const id = enq.body.id;
  writeDone(id, { passA: fullGrade() });
  const first = await ingest(id);
  assert.equal(first.status, 200);

  const subBefore = fs.readFileSync(subPath(id), 'utf8');

  // 先正常建复核任务（这一步需要原始评分），再把 passes.json 挪走，让落盘阶段失败
  const rev = await post({ kind: 'review', id });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));

  const passesFile = path.join(dirPath(id), 'passes.json');
  const passesBak = path.join(HOME, 'passes.json.bak');
  fs.renameSync(passesFile, passesBak);

  // 快照取「失败前」的状态：断言 ingest 失败没有再改动任何东西
  const dirBefore = dirSnapshot(id);

  writeDone(rev.body.id, { passB: { tr: 7, cc: 7, lr: 7, ga: 7 } });

  const bad = await ingest(rev.body.id);
  assert.equal(bad.status, 409, JSON.stringify(bad.body));
  assert.match(bad.body.error, /找不到原始评分/);

  assert.equal(fs.readFileSync(subPath(id), 'utf8'), subBefore, '前置校验失败改动了正式成绩');
  assert.deepEqual(dirSnapshot(id), dirBefore, '前置校验失败改动了记录目录');
  const st = await status(rev.body.id);
  assert.equal(st.body.status, 'failed', '失败的复核任务不该停在 done');

  // 恢复原始评分并重试
  fs.renameSync(passesBak, passesFile);
  const ok = await ingest(rev.body.id);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const after = dirSnapshot(id);
  assert.ok(after['original.md'], '重试成功后原文应该在');
  assert.equal(JSON.parse(after['meta.json']).review_count, 1);
  assert.equal(fs.readFileSync(subPath(id), 'utf8').length > 0, true);
});

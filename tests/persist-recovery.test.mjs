import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startServer } from './helpers.mjs';

// ---------------------------------------------------------------------------
// 回滚失败保护
//
// 复现：旧目录改名成备份成功 → 新目录发布失败 → 备份恢复也失败，但异常被吞，
// 函数仍返回「已回滚，正式记录未改动」；而 sweepStaging 会按时间把这份**唯一**
// 完整备份删掉。
//
// 本用例用确定性注入（持续 EACCES）走完这条路：
//   ① 错误必须明确是「回滚失败」，不能有虚假的「已回滚」；
//   ② 备份必须留下，且与操作前逐字节一致；
//   ③ 超期 + 保存别的记录之后，备份仍然在；
//   ④ 解除故障后能人工恢复，正式成绩与完整数据一致。
//
// 关键：IELTS_HOME 必须在 import lib 之前设置，否则会写到真实数据目录。
// ---------------------------------------------------------------------------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-recovery-'));
const CONFIG = path.join(HOME, 'config.json');
fs.writeFileSync(CONFIG, JSON.stringify({ mode: 'queue' }));
process.env.IELTS_HOME = HOME;
process.env.WRITING_COACH_CONFIG = CONFIG;

const ASM = path.join(HOME, 'writing', 'assessments');
const SUB = path.join(HOME, 'writing', 'submissions');
const STAGING = path.join(ASM, '.staging');
const RECOVERY = path.join(ASM, '.recovery');

const server = await startServer({ home: HOME, config: CONFIG });

const { persistAssessment, listRecoveryBackups, PersistError } = await import('../lib/persist.js');
const { finalizeResults } = await import('../lib/grading.js');
const store = await import('../lib/store.js');

const PNG_B64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ESSAY = 'Public libraries provide access to useful information. They help students find books and offer quiet places to study. Local governments should continue to support these services.';
const REVISION = 'Public libraries open up access to information for everyone.\n\nThey give students free books and quiet rooms to study in.';

const grade = {
  tr: 6.5,
  cc: 6,
  lr: 6.5,
  ga: 6,
  dims: {
    tr: { comment: '回应完整，停在 6.5。', evidence: [], fix_example: '' },
    cc: { comment: '衔接略机械。', evidence: [], fix_example: '' },
    lr: { comment: '词汇够用。', evidence: [], fix_example: '' },
    ga: { comment: '句式偏单一。', evidence: [], fix_example: '' },
  },
  errors: [],
  strengths: ['立场清楚'],
  weaknesses: ['展开不足'],
  next_actions: ['补例子'],
};

function argsFor(id, { revision = null, image = null } = {}) {
  const merged = finalizeResults(grade);
  return {
    id,
    task: 1,
    topic: 'recovery-guard',
    prompt: 'The chart below shows...',
    essay: ESSAY,
    imageBase64: image,
    wordCount: 26,
    merged,
    passes: { a: { data: grade, overall: merged.score.overall } },
    revision,
    source: 'queue',
    model: null,
    createdAt: new Date().toISOString(),
  };
}

/** 按二进制逐字节快照 */
function snapshotBuffers(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    out[name] = fs.readFileSync(path.join(dir, name));
  }
  return out;
}

function assertSameBytes(actual, expected, label) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label}：文件清单不一致`);
  for (const name of Object.keys(expected)) {
    assert.ok(actual[name].equals(expected[name]), `${label}：${name} 内容被改动`);
  }
}

test.after(async () => {
  await server.stop();
});

test('发布与恢复同时失败：明确报回滚失败、备份完整保留、超期也不被清理、可人工恢复', async () => {
  // 1) 先保存一条完整记录：正文 + 图片 + 改写 + 对话
  const id = store.reserveId(1, 'recovery-guard');
  persistAssessment(argsFor(id, { revision: REVISION, image: PNG_B64 }));
  store.appendChat(id, { role: 'user', content: '第二段为什么只有 6 分', at: new Date().toISOString() });
  store.appendChat(id, { role: 'assistant', content: '因为论证没有延展。', at: new Date().toISOString() });

  const target = path.join(ASM, id);
  const subFile = path.join(SUB, `${id}.md`);
  const before = snapshotBuffers(target);
  const subBefore = fs.readFileSync(subFile);
  assert.ok(before['image.png'], '前置条件：图片存在');
  assert.ok(before['revised.md'], '前置条件：改写存在');
  assert.ok(before['chat.jsonl'], '前置条件：对话存在');
  assert.equal((await server.api(`/api/assessments/${id}`)).status, 200, '前置条件：记录可读');

  // 2) 备份改名成功，之后新目录发布与备份恢复都持续 EACCES
  const realRename = fs.renameSync;
  let backupMoved = false;
  let injected = 0;
  fs.renameSync = (from, to, ...rest) => {
    const f = String(from);
    const t = String(to);
    if (!backupMoved && f === target && t.includes('.bak-')) {
      backupMoved = true;
      return realRename(from, to, ...rest);        // 这一次放行：旧目录成功改名
    }
    if (backupMoved && (f.includes('.staging') || f.includes('.recovery'))) {
      injected += 1;
      const e = new Error('EACCES: permission denied, rename (测试注入)');
      e.code = 'EACCES';
      throw e;
    }
    return realRename(from, to, ...rest);
  };

  let err = null;
  try {
    persistAssessment(argsFor(id, { revision: null }));
    assert.fail('发布与恢复都失败时不该成功返回');
  } catch (e) {
    err = e;
  } finally {
    fs.renameSync = realRename;
  }

  // 3) 错误必须说清楚是「回滚失败」
  assert.ok(err instanceof PersistError, `应该抛 PersistError，实际 ${err?.name}: ${err?.message}`);
  assert.equal(err.code, 'EPERSIST_ROLLBACK_FAILED');
  assert.equal(err.status, 500);
  assert.ok(injected >= 2, `应该同时注入发布与恢复两次失败，实际 ${injected} 次`);
  assert.match(err.message, /回滚失败/);
  assert.match(err.message, /发布失败/);
  assert.doesNotMatch(err.message, /已回滚/, '不能给出虚假的「已回滚」提示');
  assert.ok(err.recovery?.backupPath, '错误里必须带备份位置');
  assert.equal(err.recovery.targetPath, target);
  assert.ok(err.recovery.failures.length >= 1, '必须列出回滚失败明细');

  // 4) 原记录确实读不到了，但完整备份在，且逐字节一致
  assert.equal((await server.api(`/api/assessments/${id}`)).status, 404, '此时详情应该读不到');
  const backupDir = err.recovery.backupPath;
  assert.ok(fs.existsSync(backupDir), `备份必须保留：${backupDir}`);
  assertSameBytes(snapshotBuffers(backupDir), before, '备份');

  // 5) 模拟超过清理期限：把备份调老，再放一个超期的普通暂存垃圾
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(backupDir, threeHoursAgo, threeHoursAgo);
  fs.mkdirSync(STAGING, { recursive: true });
  const junk = path.join(STAGING, 'leftover-junk');
  fs.mkdirSync(junk, { recursive: true });
  fs.writeFileSync(path.join(junk, 'half.json'), '{"incomplete":');
  fs.utimesSync(junk, threeHoursAgo, threeHoursAgo);

  // 6) 保存另一条正常记录：会触发清理，但绝不能动那份唯一备份
  const otherId = store.reserveId(1, 'recovery-guard-other');
  const otherOut = persistAssessment(argsFor(otherId, { revision: null, image: PNG_B64 }));
  assert.equal(otherOut.id, otherId);

  assert.equal(fs.existsSync(junk), false, '超期的普通暂存应该被清掉');
  assert.ok(fs.existsSync(backupDir), `超期后备份仍在：${backupDir}`);
  assertSameBytes(snapshotBuffers(backupDir), before, '清理后的备份');

  const listed = listRecoveryBackups();
  const item = listed.find((x) => x.dir === backupDir);
  assert.ok(item, '恢复备份应该能被列出来');
  assert.equal(item.id, id);
  assert.equal(item.resolved, false, '没有确认解决之前不能标记为可清理');

  // 7) 解除故障后人工恢复：备份改名回原位
  fs.renameSync(backupDir, target);

  const detail = await server.api(`/api/assessments/${id}`);
  assert.equal(detail.status, 200, `恢复后详情应该可读：${JSON.stringify(detail.body)}`);
  assert.equal(detail.body.meta.id, id);
  assert.equal(detail.body.meta.status, 'COMPLETED');
  assert.equal(detail.body.original, ESSAY, '正文应完整恢复');
  assert.equal(detail.body.revised, REVISION, '改写应完整恢复');
  assert.equal(detail.body.chat.length, 2, '对话应完整恢复');
  assert.ok(fs.existsSync(path.join(target, 'image.png')), '图片应完整恢复');

  // 正式成绩与恢复前一致
  assert.ok(fs.readFileSync(subFile).equals(subBefore), '正式成绩文件被改动了');
  assertSameBytes(snapshotBuffers(target), before, '恢复后的记录');

  // 恢复完成后备份目录已经不存在（被改名走了）
  assert.equal(fs.existsSync(backupDir), false);
});

test('回滚成功时仍然报「已回滚」，且不留下恢复备份', async () => {
  const id = store.reserveId(1, 'rollback-ok');
  persistAssessment(argsFor(id, { revision: REVISION, image: PNG_B64 }));
  const before = snapshotBuffers(path.join(ASM, id));

  const realRename = fs.renameSync;
  let moved = false;
  fs.renameSync = (from, to, ...rest) => {
    const f = String(from);
    const t = String(to);
    if (!moved && f === path.join(ASM, id) && t.includes('.bak-')) {
      moved = true;
      return realRename(from, to, ...rest);
    }
    // 只让「上新目录」失败，回滚的 rename 放行
    if (moved && f.includes('.staging')) {
      const e = new Error('EPERM: operation not permitted（测试注入）');
      e.code = 'EPERM';
      throw e;
    }
    return realRename(from, to, ...rest);
  };
  let err = null;
  try {
    persistAssessment(argsFor(id, { revision: null }));
    assert.fail('发布失败时不该成功返回');
  } catch (e) {
    err = e;
  } finally {
    fs.renameSync = realRename;
  }

  assert.equal(err?.code, 'EPERSIST_PUBLISH');
  assert.match(err.message, /已回滚/);
  assert.equal(err.recovery, undefined, '回滚成功不该带恢复信息');
  assertSameBytes(snapshotBuffers(path.join(ASM, id)), before, '回滚后的记录');
  assert.deepEqual(
    listRecoveryBackups().filter((x) => x.id === id),
    [],
    '回滚成功不该留下恢复备份',
  );
});

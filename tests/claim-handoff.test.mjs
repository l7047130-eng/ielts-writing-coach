import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// 占位交接竞态：确定性交错，不是「多跑几次碰运气」
//
//   ① B 跑完 isIdTaken（判定未占用），在 openSync 抢占位之前停住
//   ② A 抢到同一个 ID，完整落盘（正文 + 图片 + 正式记录），然后撤占位
//   ③ 放行 B：B 的 openSync 成功（占位文件已经没了）
//
// 旧实现会把 A 已经用掉的 ID 交还给 B；正确行为是 B 复核发现冲突、换号。
// 验收不只看报不报错：两篇正文、图片、正式记录都必须完整留下。
// ---------------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(ROOT, 'tests', 'helpers', 'claim-race-child.mjs');
const CHILD_URL = pathToFileURL(CHILD).href;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, ...args], {
      cwd: ROOT,
      env: { ...process.env, IELTS_HOME: args[2] },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`子进程退出 ${code}\n${err || out}`));
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch (e) {
        reject(new Error(`子进程输出解析失败：${out}\n${err}`));
      }
    });
  });
}

function spawnChildDetached(args) {
  const child = spawn(process.execPath, [CHILD, ...args], {
    cwd: ROOT,
    env: { ...process.env, IELTS_HOME: args[2] },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`子进程退出 ${code}\n${err || out}`));
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch {
        reject(new Error(`子进程输出解析失败：${out}\n${err}`));
      }
    });
  });
  return { child, done };
}

function waitForFile(file, timeout = 20000) {
  const t0 = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - t0 > timeout) throw new Error(`等屏障超时：${file}`);
    sleepSync(20);
  }
}

function assertRecordSurvived(home, id, tag) {
  const asm = path.join(home, 'writing', 'assessments', id);
  const sub = path.join(home, 'writing', 'submissions', `${id}.md`);
  assert.ok(fs.existsSync(asm), `${tag} 的评估目录丢了：${id}`);
  assert.ok(fs.existsSync(sub), `${tag} 的正式记录丢了：${id}.md`);
  const original = fs.readFileSync(path.join(asm, 'original.md'), 'utf8');
  assert.match(original, new RegExp(`written by ${tag}`), `${tag} 的正文被别人覆盖了`);
  assert.ok(fs.existsSync(path.join(asm, 'image.png')), `${tag} 的图片丢了`);
  const claim = path.join(home, 'writing', 'queue', 'claims', `${id}.json`);
  assert.equal(fs.existsSync(claim), false, `${tag} 的占位没撤干净`);
}

async function runHandoff({ alloc, label }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `wc-handoff-${label}-`));
  const barrier = path.join(home, 'barrier');
  fs.mkdirSync(barrier, { recursive: true });
  const topic = `handoff-${label}`;

  // B 先跑到「检查完、还没占位」
  const b = spawnChildDetached(['B', alloc, home, barrier, topic, 'B']);
  waitForFile(path.join(barrier, 'b-ready'));

  // A 完整跑完一轮：占位 → 落盘 → 撤占位
  const a = await runChild(['A', alloc, home, barrier, topic, 'A']);

  // 放行 B
  fs.writeFileSync(path.join(barrier, 'b-go'), '1');
  const bb = await b.done;

  return { home, a, b: bb };
}

test('reserveId 交接窗口：B 复核发现冲突并换号，两篇都完整保留', async () => {
  const { home, a, b } = await runHandoff({ alloc: 'reserveId', label: 'reserveId' });

  assert.notEqual(a.id, b.id, `B 复用了 A 的 ID：${a.id}`);
  assert.match(b.id, /-2$/, `B 应该拿到下一个序号，实际 ${b.id}`);
  assertRecordSurvived(home, a.id, 'A');
  assertRecordSurvived(home, b.id, 'B');

  // 两篇正文互不覆盖
  const aText = fs.readFileSync(path.join(home, 'writing', 'assessments', a.id, 'original.md'), 'utf8');
  const bText = fs.readFileSync(path.join(home, 'writing', 'assessments', b.id, 'original.md'), 'utf8');
  assert.notEqual(aText, bText);
  assert.match(aText, /written by A/);
  assert.match(bText, /written by B/);
});

test('reserveNamedId 同样补上交接窗口', async () => {
  const { home, a, b } = await runHandoff({ alloc: 'reserveNamedId', label: 'named' });

  assert.notEqual(a.id, b.id, `B 复用了 A 的 ID：${a.id}`);
  assert.match(b.id, /-2$/, `B 应该拿到下一个序号，实际 ${b.id}`);
  assertRecordSurvived(home, a.id, 'A');
  assertRecordSurvived(home, b.id, 'B');
});

// ---------------------------------------------------------------------------
// 释放逻辑：占位所有权
// ---------------------------------------------------------------------------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-claimown-'));
process.env.IELTS_HOME = HOME;
process.env.WRITING_COACH_CONFIG = path.join(HOME, 'config.json');

const ids = await import('../lib/ids.js');
const queue = await import('../lib/queue.js');

const claimPath = (id) => path.join(HOME, 'writing', 'queue', 'claims', `${id}.json`);

test('释放后同名可再用；失败/取消路径也会把占位还回去', () => {
  const id = ids.reserveId(2, 'release-reuse');
  assert.ok(fs.existsSync(claimPath(id)));
  ids.releaseClaim(id);
  assert.equal(fs.existsSync(claimPath(id)), false);
  // 释放后同一个号能再次占到（说明占位确实撤干净了）
  const again = ids.reserveId(2, 'release-reuse');
  assert.equal(again, id);
  ids.releaseClaim(again);
});

test('取消任务（clearTask）会清掉占位，不留陈旧锁', () => {
  const id = ids.reserveId(2, 'cancel-me');
  // 手工写 pending（不走 enqueue，enqueue 成功会自己撤占位）
  fs.mkdirSync(path.join(HOME, 'writing', 'queue', 'pending'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'writing', 'queue', 'pending', `${id}.json`), JSON.stringify({ id }));
  assert.ok(fs.existsSync(claimPath(id)), '落盘前占位应该还在');

  queue.clearTask(id);
  assert.equal(fs.existsSync(claimPath(id)), false);
  assert.equal(fs.existsSync(path.join(HOME, 'writing', 'queue', 'pending', `${id}.json`)), false);

  // 取消后同一个号能再用
  const again = ids.reserveId(2, 'cancel-me');
  assert.equal(again, id);
  ids.releaseClaim(again);
});

test('占位所有权：别人接手后，延迟的释放不会误删', () => {
  const id = ids.reserveId(2, 'handover');
  // 模拟交接：本进程撤掉占位（比如已落盘），另一个进程接手同一个号
  ids.releaseClaim(id);
  fs.mkdirSync(path.dirname(claimPath(id)), { recursive: true });
  fs.writeFileSync(claimPath(id), JSON.stringify({ id, token: 'other-process-token' }));

  // 本进程又来一次延迟释放（比如 finally 里的 releaseClaim）
  assert.equal(ids.releaseClaim(id), false, '不该删掉别人的占位');
  assert.ok(fs.existsSync(claimPath(id)), '别人的占位文件还在');
  assert.equal(JSON.parse(fs.readFileSync(claimPath(id), 'utf8')).token, 'other-process-token');

  // 显式清理（从未占过、或已释放过）走另一条路：手动删
  fs.rmSync(claimPath(id), { force: true });
});

test('同进程重复 settle 不会误删后续占位', () => {
  const id = ids.reserveId(2, 'double-settle');
  // 手工写 pending 当作落盘痕迹
  fs.mkdirSync(path.join(HOME, 'writing', 'queue', 'pending'), { recursive: true });
  const pf = path.join(HOME, 'writing', 'queue', 'pending', `${id}.json`);
  fs.writeFileSync(pf, JSON.stringify({ id }));

  assert.equal(ids.settleClaim(id), true, 'pending 已经守门，应该撤占位');
  // 同一个进程再 settle 一次（迟到的 finally），此时别人已经接手
  fs.writeFileSync(claimPath(id), JSON.stringify({ id, token: 'late-owner' }));
  assert.equal(ids.settleClaim(id), false, '迟到的 settle 不该碰别人的占位');
  assert.ok(fs.existsSync(claimPath(id)));
  fs.rmSync(pf, { force: true });
});

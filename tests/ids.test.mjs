import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ids-'));
process.env.IELTS_HOME = HOME;
process.env.WRITING_COACH_CONFIG = path.join(HOME, 'config.json');

const ids = await import('../lib/ids.js');
const queue = await import('../lib/queue.js');
const { PATHS } = await import('../lib/paths.js');

const Q = (bucket) => path.join(HOME, 'writing', 'queue', bucket);
const todayStem = (task, topic) => `${ids.stamp().compact}_task${task}_${ids.slugify(topic)}`;

test('同一话题连续预留拿到不同 ID', () => {
  const a = ids.reserveId(2, 'same-topic');
  const b = ids.reserveId(2, 'same-topic');
  const c = ids.reserveId(2, 'same-topic');
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
  assert.match(b, /-2$/);
  assert.match(c, /-3$/);
});

test('正式记录、评估目录、pending / done / failed 都会挡住同名 ID', () => {
  const topic = 'occupied';
  const base = todayStem(2, topic);

  for (const bucket of ['submissions-md', 'assessments-dir', 'pending', 'done', 'failed']) {
    const id = `${base}-${bucket}`;
    if (bucket === 'submissions-md') {
      fs.mkdirSync(PATHS.writing.submissions, { recursive: true });
      fs.writeFileSync(path.join(PATHS.writing.submissions, `${id}.md`), 'x');
    } else if (bucket === 'assessments-dir') {
      fs.mkdirSync(path.join(PATHS.writing.assessments, id), { recursive: true });
    } else {
      fs.mkdirSync(Q(bucket), { recursive: true });
      fs.writeFileSync(path.join(Q(bucket), `${id}.json`), '{}');
    }
    assert.equal(ids.isIdTaken(id), true, `${bucket} 里的 ${id} 应该被判为已占用`);
  }
});

test('预留结果反映到文件名序号上，不会覆盖已有 pending', () => {
  const topic = 'no-overwrite';
  const first = ids.reserveId(2, topic);
  queue.enqueue({ id: first, kind: 'full', created_at: new Date().toISOString(), task: 2, topic, essay: 'A' });
  const second = ids.reserveId(2, topic);
  queue.enqueue({ id: second, kind: 'full', created_at: new Date().toISOString(), task: 2, topic, essay: 'B' });

  assert.notEqual(first, second);
  const a = JSON.parse(fs.readFileSync(path.join(Q('pending'), `${first}.json`), 'utf8'));
  const b = JSON.parse(fs.readFileSync(path.join(Q('pending'), `${second}.json`), 'utf8'));
  assert.equal(a.essay, 'A');
  assert.equal(b.essay, 'B');
});

test('enqueue 拒绝覆盖同 id 的 pending 文件', () => {
  const id = ids.reserveId(2, 'dup-guard');
  queue.enqueue({ id, task: 2, topic: 'dup-guard', essay: 'first' });
  assert.throws(
    () => queue.enqueue({ id, task: 2, topic: 'dup-guard', essay: 'second' }),
    /已经有/,
  );
  const kept = JSON.parse(fs.readFileSync(path.join(Q('pending'), `${id}.json`), 'utf8'));
  assert.equal(kept.essay, 'first');
});

test('多进程同时预留也不会撞 ID（openSync wx 是 OS 级互斥）', async () => {
  const { pathToFileURL } = await import('node:url');
  const idsUrl = pathToFileURL(path.join(ROOT, 'lib', 'ids.js')).href;
  const script = `
    process.env.IELTS_HOME = ${JSON.stringify(HOME)};
    process.env.WRITING_COACH_CONFIG = ${JSON.stringify(path.join(HOME, 'config.json'))};
    const { reserveId } = await import(${JSON.stringify(idsUrl)});
    const out = [];
    for (let i = 0; i < 12; i += 1) out.push(reserveId(2, 'cross-proc'));
    console.log(JSON.stringify(out));
  `;

  const run = (env) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      env: { ...process.env, IELTS_HOME: HOME, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(err || `code ${code}`))));
  });

  const [a, b] = await Promise.all([run({ TAG: 'a' }), run({ TAG: 'b' })]);
  assert.equal(a.length, 12);
  assert.equal(b.length, 12);
  const all = [...a, ...b];
  assert.equal(new Set(all).size, 24, `出现重复 ID：${all.join(', ')}`);
});

test('复核用 reserveNamedId 生成独立 id，可多次复核', () => {
  const a = ids.reserveNamedId('review-20261024_task2_x');
  const b = ids.reserveNamedId('review-20261024_task2_x');
  assert.notEqual(a, b);
  assert.equal(a, 'review-20261024_task2_x');
  assert.equal(b, 'review-20261024_task2_x-2');
});

test('clearTask 清掉队列痕迹与占位，导入标记单独保留', () => {
  const id = ids.reserveId(2, 'clear-me');
  queue.enqueue({ id, task: 2, topic: 'clear-me', essay: 'x' });
  queue.markFailed(id, '坏结果');
  queue.markImported(id, id);
  assert.equal(fs.existsSync(path.join(Q('pending'), `${id}.json`)), true);
  queue.clearTask(id);
  assert.equal(fs.existsSync(path.join(Q('pending'), `${id}.json`)), false);
  assert.equal(fs.existsSync(path.join(Q('failed'), `${id}.json`)), false);
  assert.equal(fs.existsSync(path.join(Q('claims'), `${id}.json`)), false);
  assert.equal(queue.readImported(id)?.assessment_id, id);
});

test('settleClaim 只在有痕迹时才撤占位', () => {
  const id = ids.reserveId(2, 'settle');
  const claimFile = path.join(Q('claims'), `${id}.json`);
  assert.equal(fs.existsSync(claimFile), true);
  assert.equal(ids.settleClaim(id), false, '还没有任何痕迹，不该撤');
  fs.mkdirSync(path.join(PATHS.writing.assessments, id), { recursive: true });
  assert.equal(ids.settleClaim(id), true);
  assert.equal(fs.existsSync(claimFile), false);
});

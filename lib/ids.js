import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  PATHS,
  QPATHS,
  assessmentDir,
  ensureDirs,
  isInside,
  submissionFile,
} from './paths.js';

// ---------------------------------------------------------------------------
// ID 的唯一性来源
//
// 之前 nextId 只看 submissions / assessments，同一天同话题连交两篇会拿到同一个 ID。
// 现在是「原子占位 + 占位后复核」：
//   1. openSync(file, 'wx') 在 OS 层抢锁，抢不到就换下一个序号；
//   2. 抢到以后再核对一遍其它存储位，补上「B 检查完 → A 落盘并释放占位 → B 占位成功」
//      这个交接窗口（wx 只保护占位文件存在的那段，释放之后的空档是另一回事）。
//
// ID 字符集：中文 / 中英混合同理允许（slugify 本来就保留中文），
// 但继续拒绝路径分隔符、`..`、绝对路径、控制字符、Windows 保留名。
// ---------------------------------------------------------------------------

// 首字符必须是字母或数字（含全角），后面允许字母数字、下划线、点、短横线。
// 不在类里的一律拒绝：\ / : * ? " < > | 空格、控制字符都进不来。
const ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u;
// Windows 设备名，带不带扩展名都不能当文件名
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 外部传入的 ID 一律先过这里 */
export function isSafeId(id) {
  if (typeof id !== 'string') return false;
  if (!id || id.length > 128) return false;
  if (!ID_RE.test(id)) return false;
  if (id === '.' || id === '..') return false;
  if (id.includes('..')) return false;          // 连 a..b 也拒绝，宁严不宽
  if (id.endsWith('.')) return false;           // Windows 会吃掉结尾的点
  if (WIN_RESERVED.test(id)) return false;
  return true;
}

export function assertSafeId(id, label = 'id') {
  if (!isSafeId(id)) {
    throw Object.assign(
      new Error(
        `${label} 不合法：只允许字母、数字、下划线、点和短横线（中文可以），`
        + `不能包含路径分隔符、.. 或 Windows 保留名。收到 ${JSON.stringify(String(id)).slice(0, 60)}`
      ),
      { code: 'EID', status: 400 }
    );
  }
  return id;
}

export function stamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return { date: `${y}-${m}-${day}`, compact: `${y}${m}${day}` };
}

/** 中文原样保留，只把标点/空白折叠成短横线 */
export function slugify(topic, fallback = 'essay') {
  const s = String(topic || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || fallback;
}

// ---------------------------------------------------------------------------
// 占用检查
// ---------------------------------------------------------------------------
function bucketTaken(bucket, id) {
  const f = path.resolve(QPATHS[bucket], `${id}.json`);
  return isInside(QPATHS[bucket], f) && fs.existsSync(f);
}

/**
 * 这个 ID 是否已经被任何一处占用。
 * @param {object} opts
 * @param {boolean} opts.ignoreClaim  跳过 claims/（自己的占位不算占用）
 */
export function isIdTaken(id, { ignoreClaim = false } = {}) {
  if (!isSafeId(id)) return true;
  try {
    if (fs.existsSync(submissionFile(id))) return true;
    if (fs.existsSync(assessmentDir(id))) return true;
  } catch {
    return true;
  }
  for (const bucket of ['pending', 'done', 'failed', 'imported']) {
    try {
      if (bucketTaken(bucket, id)) return true;
    } catch {
      return true;
    }
  }
  if (!ignoreClaim) {
    try {
      if (bucketTaken('claims', id)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 占位：带 token，谁创建谁负责，释放时只认自己那一份
// ---------------------------------------------------------------------------
function claimFile(id) {
  const p = path.resolve(QPATHS.claims, `${id}.json`);
  if (!isInside(QPATHS.claims, p)) {
    throw Object.assign(new Error('占位文件路径越界'), { code: 'EPATH' });
  }
  return p;
}

// id -> { token, done }
// done=true 表示本进程已经释放过这个 id 的占位，
// 之后 releaseClaim 不许再动别人的同名占位（防「延迟释放误删接手者的占位」）。
const OWN_CLAIMS = new Map();

function readClaimToken(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.token || null;
  } catch {
    return null;
  }
}

/** 原子占位。抢到返回 token，没抢到返回 null */
function tryClaim(id, meta = {}) {
  fs.mkdirSync(QPATHS.claims, { recursive: true });
  const file = claimFile(id);
  const token = crypto.randomUUID();
  let fd;
  try {
    fd = fs.openSync(file, 'wx');   // ← 关键：EEXIST 之外的失败才算异常
  } catch (e) {
    if (e.code === 'EEXIST') return null;
    throw e;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ id, token, at: new Date().toISOString(), ...meta }));
  } finally {
    fs.closeSync(fd);
  }
  OWN_CLAIMS.set(id, { token, done: false });
  return token;
}

/**
 * 占位后复核：除了自己的占位，别的地方有没有这个 ID 的痕迹。
 * 有的话说明「别人先占过、落了盘、把占位撤了」，这个号不能要。
 */
function occupiedElsewhere(id) {
  return isIdTaken(id, { ignoreClaim: true });
}

/**
 * 预留一个唯一 ID。占位文件留在 queue/claims/ 下，直到真正落盘（或取消）。
 * 并发请求、pending 已有同名、done/failed 残留、跨进程交接，都会各自拿到不同 ID。
 */
export function reserveId(task, topic, { maxTries = 999, prefix = '' } = {}) {
  const { compact } = stamp();
  const base = `${prefix}${compact}_task${task}_${slugify(topic)}`;
  return claimFresh({ base, maxTries, meta: { task, topic }, label: '任务' });
}

/** 复核用：在给定 base 上占位，保证同一条记录可以多次复核而不互相覆盖 */
export function reserveNamedId(base, meta = {}, { maxTries = 99 } = {}) {
  const safeBase = String(base || 'review').replace(/[^\p{L}\p{N}._-]/gu, '-');
  return claimFresh({ base: safeBase, maxTries, meta, label: '复核' });
}

function claimFresh({ base, maxTries, meta, label }) {
  ensureDirs();                       // reserveNamedId 也要建目录，否则落盘时 ENOENT
  for (let n = 1; n <= maxTries; n += 1) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (isIdTaken(id)) continue;          // 快速跳过，省一次 open
    const token = tryClaim(id, meta);
    if (!token) continue;                 // 抢占失败，换下一个

    // 占位后复核，补上释放后的交接窗口
    if (occupiedElsewhere(id)) {
      releaseClaim(id);
      continue;
    }
    return id;
  }
  throw new Error(`生成${label} ID 失败：${maxTries} 个候选全部被占用`);
}

/** 兼容旧调用名：语义从「看一眼」变成「占位」，两者都不会撞车 */
export function nextId(task, topic) {
  return reserveId(task, topic);
}

/**
 * 释放占位。只认自己创建的那份：
 * - 本进程创建过、token 对得上 → 删
 * - 本进程创建过、token 对不上（别人已经接手）→ 不碰
 * - 本进程释放过同一个 id → 不碰（防延迟的 settle 误删接手者的占位）
 * - 本进程从没碰过这个 id → 当作显式清理（取消任务），直接删
 */
export function releaseClaim(id) {
  if (!isSafeId(id)) return false;
  const file = claimFile(id);
  const rec = OWN_CLAIMS.get(id);

  if (rec?.done) return false;

  try {
    if (!fs.existsSync(file)) {
      if (rec) rec.done = true;
      return false;
    }
    const tok = readClaimToken(file);
    if (rec) {
      if (tok !== rec.token) {
        rec.done = true;                 // 别人的占位，绝不误删
        return false;
      }
      fs.rmSync(file, { force: true });
      rec.done = true;
      return true;
    }
    // 没有本进程的占位记录：显式清理（取消 / 陈旧占位）
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 正式记录已经落盘，占位文件可以撤了（submissions/*.md 或 assessments/<id>/ 已经在守门）。
 * 若还没有可依赖的痕迹，就保留占位，防止后续同名覆盖。
 */
export function settleClaim(id) {
  if (!isSafeId(id)) return false;
  let guarded = false;
  try {
    guarded = fs.existsSync(submissionFile(id))
      || fs.existsSync(assessmentDir(id))
      || ['pending', 'done', 'failed'].some((b) => bucketTaken(b, id));
  } catch {
    guarded = false;
  }
  if (!guarded) return false;
  return releaseClaim(id);
}

/** 测试用：本进程占位归属状态 */
export function claimOwnerState(id) {
  return OWN_CLAIMS.get(id) || null;
}

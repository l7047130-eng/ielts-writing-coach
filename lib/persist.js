import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DIM_KEYS, isBand, toHalf } from './contract.js';
import { assertSafeId } from './ids.js';
import {
  IMAGE_EXTS,
  PATHS,
  QPATHS,
  assessmentDir,
  assertImageSource,
  removeTree,
  resolveInside,
} from './paths.js';
import * as store from './store.js';

// ---------------------------------------------------------------------------
// 落盘的唯一出口。API / 队列 / 粘贴 / 复核四条路径共用。
//
// 之前是「先写 submissions，再校验并复制图片」：图片被拒时正式成绩已经进了老看板，
// 而 assessments/<id>/ 只有 original.md、没有 meta.json，详情接口 404——
// 一次失败留下两处不一致的半成品。
//
// 现在分三步，校验全部前移：
//   1. prepare  纯计算与只读检查（分数、元数据、来源目录、类型、存在性、可读性）
//   2. stage    在 .staging/<id>-<rand>/ 里把整套文件写齐（含继承旧记录的对话/改写/图片）
//   3. publish  备份旧目录 → 换上新目录 → 原子写 submissions；任何一步失败整体回滚
//
// .staging 是 assessments 下的隐藏目录：listAssessments 用 isSafeId 过滤，
// 首字符是点，不会被当成记录列出来。
// ---------------------------------------------------------------------------
const STAGING_ROOT = path.join(PATHS.writing.assessments, '.staging');
// 恢复备份单独放：它可能是这条记录的唯一完整副本，绝不能按时间自动删
const RECOVERY_ROOT = path.join(PATHS.writing.assessments, '.recovery');
// 更新已有记录时原样保留的东西（复核不能把对话、改写、图片弄丢）
const PRESERVE_FILES = ['chat.jsonl', 'revised.md'];
const STAGING_TTL_MS = 60 * 60 * 1000;
const RESOLVED_SUFFIX = '.resolved';

export class PersistError extends Error {
  constructor(message, { code = 'EPERSIST', status = 422, cause = null, recovery = null } = {}) {
    super(message);
    this.name = 'PersistError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
    // 回滚失败时带上「备份在哪、恢复到哪」，调用方要原样透出
    if (recovery) this.recovery = recovery;
  }
}

const rand = () => crypto.randomBytes(5).toString('hex');

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function writeAtomic(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// 1. 写入前的校验（全部只读，不产生任何正式文件）
// ---------------------------------------------------------------------------
function decodeBase64Image(base64) {
  const m = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(String(base64).trim());
  if (!m) {
    throw new PersistError('图片不是合法的 data:image/base64 数据，拒绝落盘', {
      code: 'EPERSIST_IMAGE_TYPE',
      status: 400,
    });
  }
  const mime = m[1].toLowerCase();
  // 统一带点，stage 里直接用 image${ext}
  const ext = mime === 'jpeg' ? '.jpg' : `.${mime}`;
  if (!IMAGE_EXTS.includes(ext)) {
    throw new PersistError(`图片类型不支持：${mime}，只允许 ${IMAGE_EXTS.join(' / ')}`, {
      code: 'EPERSIST_IMAGE_TYPE',
      status: 400,
    });
  }
  const raw = m[2].replace(/\s+/g, '');
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new PersistError('图片 base64 内容非法，拒绝落盘', {
      code: 'EPERSIST_IMAGE_TYPE',
      status: 400,
    });
  }
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) {
    throw new PersistError('图片内容为空，拒绝落盘', { code: 'EPERSIST_IMAGE_EMPTY', status: 400 });
  }
  return { kind: 'buffer', buffer, ext };
}

/** 来源目录、类型、存在性、是否为文件、可读性，全部在写之前查清 */
function inspectImageFile(srcPath, allowRoots) {
  let src;
  let ext;
  try {
    ({ src, ext } = assertImageSource(srcPath, allowRoots));
  } catch (e) {
    throw new PersistError(e.message, { code: 'EPERSIST_IMAGE_SOURCE', status: 400, cause: e });
  }

  let st;
  try {
    st = fs.statSync(src);
  } catch (e) {
    throw new PersistError(`图片文件不存在或无法访问：${srcPath}`, {
      code: 'EPERSIST_IMAGE_MISSING',
      status: 400,
      cause: e,
    });
  }
  if (!st.isFile()) {
    throw new PersistError(`图片来源不是文件：${srcPath}`, { code: 'EPERSIST_IMAGE_MISSING', status: 400 });
  }
  if (!st.size) {
    throw new PersistError(`图片文件是空的：${srcPath}`, { code: 'EPERSIST_IMAGE_EMPTY', status: 400 });
  }

  let fd;
  try {
    fd = fs.openSync(src, 'r');
    const probe = Buffer.alloc(1);
    const n = fs.readSync(fd, probe, 0, 1, 0);
    if (n !== 1) throw new Error('读不到内容');
  } catch (e) {
    throw new PersistError(`图片文件读不出来：${e.message}`, {
      code: 'EPERSIST_IMAGE_UNREADABLE',
      status: 400,
      cause: e,
    });
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  return { kind: 'file', src, ext, size: st.size };
}

function assertScore(merged) {
  const score = merged?.score;
  if (!score || typeof score !== 'object') {
    throw new PersistError('评分结果缺少 score，拒绝落盘', { code: 'EPERSIST_SCORE', status: 422 });
  }
  for (const k of DIM_KEYS) {
    if (!isBand(Number(score[k]))) {
      throw new PersistError(`分数不合法：${k}=${JSON.stringify(score[k])}（要求 0~9、0.5 步进）`, {
        code: 'EPERSIST_SCORE',
        status: 422,
      });
    }
  }
  if (!isBand(Number(score.overall))) {
    throw new PersistError(`综合分不合法：${JSON.stringify(score.overall)}`, {
      code: 'EPERSIST_SCORE',
      status: 422,
    });
  }
  if (!Array.isArray(merged.errors)) {
    throw new PersistError('评分结果缺少 errors 数组，拒绝落盘', { code: 'EPERSIST_SCORE', status: 422 });
  }
}

/**
 * 准备阶段：只读 + 纯计算。任何一项不合格都在这里抛出，磁盘上不会多出半个文件。
 */
function prepare({
  id,
  task,
  topic,
  prompt,
  essay,
  imageBase64,
  imagePath,
  imageSourceRoots,
  wordCount,
  durationMin,
  merged,
  passes,
  revision,
  source,
  model,
  createdAt,
  date,
  metaExtra,
}) {
  try {
    assertSafeId(id);
  } catch (e) {
    throw new PersistError(e.message, { code: 'EPERSIST_ID', status: 400, cause: e });
  }

  const taskNo = Number(task);
  if (![1, 2].includes(taskNo)) {
    throw new PersistError('task 必须是 1 或 2，拒绝落盘', { code: 'EPERSIST_INPUT', status: 400 });
  }
  const body = String(essay || '');
  if (!body.trim()) {
    throw new PersistError('作文正文为空，拒绝落盘', { code: 'EPERSIST_INPUT', status: 400 });
  }
  if (!passes || !passes.a || !passes.a.data) {
    throw new PersistError('缺少原始评分（passes.a.data），拒绝落盘', {
      code: 'EPERSIST_INPUT',
      status: 422,
    });
  }

  assertScore(merged);

  let image = null;
  if (imageBase64) image = decodeBase64Image(imageBase64);
  else if (imagePath) image = inspectImageFile(imagePath, imageSourceRoots);

  const recordDate = date || store.stamp().date;
  const submission = {
    date: recordDate,
    task: taskNo,
    topic,
    score: {
      tr: toHalf(merged.score.tr),
      cc: toHalf(merged.score.cc),
      lr: toHalf(merged.score.lr),
      ga: toHalf(merged.score.ga),
      overall: toHalf(merged.score.overall),
    },
    errors: merged.errors.map((e) => ({ type: e.type, tag: e.tag, count: e.count })),
    word_count: wordCount,
    ...(durationMin ? { duration_min: Number(durationMin) } : {}),
    essay: body,
  };

  // 渲染时就会跑老看板的 schema 校验，不合法直接抛，不落到磁盘
  let rendered;
  try {
    rendered = store.renderSubmission(submission, id);
  } catch (e) {
    throw new PersistError(e.message, { code: 'EPERSIST_CONTRACT', status: 422, cause: e });
  }

  const meta = {
    id,
    created_at: createdAt,
    date: submission.date,
    task: taskNo,
    topic,
    prompt,
    word_count: wordCount,
    duration_min: durationMin ? Number(durationMin) : null,
    score: submission.score,
    pass_overall: merged.pass_overall,
    spread: merged.spread,
    boundary: merged.boundary,
    status: 'COMPLETED',
    source,
    model,
    submission_file: rendered.file,
    ...(metaExtra && typeof metaExtra === 'object' ? metaExtra : {}),
  };

  return { id, body, image, merged, passes, revision, meta, rendered };
}

// ---------------------------------------------------------------------------
// 2. 暂存：整套文件先写进 .staging，写完才谈发布
// ---------------------------------------------------------------------------
/**
 * 只清普通暂存。
 * .staging 下只会出现「还没发布成功的半成品」，删掉最多重跑一次；
 * 恢复备份在 .recovery 里，这里一个都不碰。
 */
function sweepStaging() {
  let entries = [];
  try {
    entries = fs.readdirSync(STAGING_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const e of entries) {
    // 旧版本把备份放在 .staging 里过；看到 .bak- 一律不碰
    if (e.name.includes('.bak-')) continue;
    const full = path.join(STAGING_ROOT, e.name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs > STAGING_TTL_MS) removeTree(full);
    } catch { /* ignore */ }
  }
}

/**
 * 只清「已确认不再承担恢复作用」的备份：
 * 成功发布后删除备份失败时，会在旁边留一个 <backup>.resolved 标记，
 * 只有带标记且超过保留期的才自动清。没有标记的备份一律不动——
 * 它可能就是这条记录唯一完整的那份数据。
 */
function sweepResolvedBackups() {
  let entries = [];
  try {
    entries = fs.readdirSync(RECOVERY_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const e of entries) {
    if (!e.name.endsWith(RESOLVED_SUFFIX)) continue;
    const marker = path.join(RECOVERY_ROOT, e.name);
    try {
      const st = fs.statSync(marker);
      if (now - st.mtimeMs <= STAGING_TTL_MS) continue;
      const backup = marker.slice(0, -RESOLVED_SUFFIX.length);
      if (fs.existsSync(backup)) {
        removeTree(backup);
        if (fs.existsSync(backup)) continue;    // 没删掉就留着标记，下次再试
      }
      fs.rmSync(marker, { force: true });
    } catch { /* ignore */ }
  }
}

/** 列出当前保留的恢复备份，供排错和人工恢复 */
export function listRecoveryBackups() {
  let entries = [];
  try {
    entries = fs.readdirSync(RECOVERY_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.includes('.bak-'))
    .map((e) => {
      const dir = path.join(RECOVERY_ROOT, e.name);
      const id = e.name.split('.bak-')[0];
      let mtimeMs = null;
      try { mtimeMs = fs.statSync(dir).mtimeMs; } catch { /* ignore */ }
      return { id, dir, mtimeMs, resolved: fs.existsSync(`${dir}${RESOLVED_SUFFIX}`) };
    });
}

/** 旧记录里要继承的东西：对话、改写、图片 */
function inheritExisting(id, dir) {
  const existing = assessmentDir(id);
  let st;
  try {
    st = fs.statSync(existing);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;

  for (const name of PRESERVE_FILES) {
    const f = path.join(existing, name);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, name));
  }
  for (const ext of IMAGE_EXTS) {
    const f = path.join(existing, `image${ext}`);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, `image${ext}`));
  }
}

function stage({ id, body, image, merged, passes, revision, meta }) {
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  sweepStaging();
  sweepResolvedBackups();

  const dir = path.join(STAGING_ROOT, `${id}-${rand()}`);
  fs.mkdirSync(dir, { recursive: true });

  try {
    inheritExisting(id, dir);

    fs.writeFileSync(path.join(dir, 'original.md'), body, 'utf8');

    if (image) {
      const target = path.join(dir, `image${image.ext}`);
      try {
        if (image.kind === 'buffer') fs.writeFileSync(target, image.buffer);
        else fs.copyFileSync(image.src, target);
      } catch (e) {
        throw new PersistError(`图片复制失败：${e.message}`, {
          code: 'EPERSIST_IMAGE_COPY',
          status: 500,
          cause: e,
        });
      }
      // 新图扩展名和旧图不同时，别在同一目录留两张
      for (const ext of IMAGE_EXTS) {
        if (ext === image.ext) continue;
        const old = path.join(dir, `image${ext}`);
        if (fs.existsSync(old)) fs.rmSync(old, { force: true });
      }
    }

    if (passes) writeJSON(path.join(dir, 'passes.json'), passes);
    if (merged) writeJSON(path.join(dir, 'merged.json'), merged);
    if (revision) fs.writeFileSync(path.join(dir, 'revised.md'), String(revision), 'utf8');
    // meta.json 最后写：它是「这个目录完整」的标记
    writeJSON(path.join(dir, 'meta.json'), meta);

    return dir;
  } catch (e) {
    removeTree(dir);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 3. 发布：备份旧记录 → 换新目录 → 写契约文件；失败整体回滚
// ---------------------------------------------------------------------------
/**
 * 回滚发布。每一步都显式记录成败——这里的失败意味着磁盘上可能只剩备份，
 * 不能再吞掉当成「已回滚」。
 */
function rollbackPublish({ target, backup, hadTarget, dirPublished, subPath, hadSub, subOld }) {
  const failures = [];

  if (dirPublished) {
    try {
      removeTree(target);
      if (fs.existsSync(target)) failures.push({ step: 'remove-new-dir', message: '新目录未能删除' });
    } catch (e) {
      failures.push({ step: 'remove-new-dir', message: e.message });
    }
  }

  if (hadTarget) {
    try {
      fs.renameSync(backup, target);
    } catch (e) {
      failures.push({ step: 'restore-backup', message: e.message });
    }
    if (!fs.existsSync(target)) {
      failures.push({ step: 'restore-backup', message: '备份没有恢复回原位置' });
    }
  }

  if (subPath) {
    try {
      if (hadSub) writeAtomic(subPath, subOld);
      else if (fs.existsSync(subPath)) fs.rmSync(subPath, { force: true });
    } catch (e) {
      failures.push({ step: 'restore-submission', message: e.message });
    }
  }

  return { ok: failures.length === 0, failures };
}

function publish({ id, stagedDir, submission }) {
  const target = assessmentDir(id);
  const hadTarget = fs.existsSync(target);
  fs.mkdirSync(RECOVERY_ROOT, { recursive: true });
  const backup = path.join(RECOVERY_ROOT, `${id}.bak-${rand()}`);

  const subPath = submission?.path || null;
  const hadSub = Boolean(subPath) && fs.existsSync(subPath);
  const subOld = hadSub ? fs.readFileSync(subPath, 'utf8') : null;
  let dirPublished = false;
  let backupMoved = false;

  try {
    if (hadTarget) {
      fs.renameSync(target, backup);
      backupMoved = true;
    }
    fs.renameSync(stagedDir, target);
    dirPublished = true;
    if (submission) writeAtomic(subPath, submission.content);
  } catch (e) {
    const rollback = rollbackPublish({
      target,
      backup: backupMoved ? backup : null,
      hadTarget: hadTarget && backupMoved,
      dirPublished,
      subPath,
      hadSub,
      subOld,
    });

    if (!rollback.ok) {
      // 回滚没成功：备份绝对不能删，错误里要写清楚它在哪、怎么人工恢复
      const detail = rollback.failures.map((f) => `${f.step}: ${f.message}`).join('；');
      throw new PersistError(
        `发布失败，且回滚失败：这条记录暂时读不到，完整备份在 ${backup}。`
        + `恢复步骤：停止写入后，把这个目录改名为 ${target}。`
        + `触发原因：${e.message}。回滚失败明细：${detail}`,
        {
          code: 'EPERSIST_ROLLBACK_FAILED',
          status: 500,
          cause: e,
          recovery: {
            id,
            backupPath: backup,
            targetPath: target,
            failures: rollback.failures,
            trigger: e.message,
            restoreHint: `把 ${backup} 改名为 ${target}`,
          },
        }
      );
    }

    // 回滚成功：此时备份已经被改回原位，磁盘等于操作前
    throw new PersistError(`发布失败，已回滚，正式记录未改动：${e.message}`, {
      code: 'EPERSIST_PUBLISH',
      status: 500,
      cause: e,
    });
  }

  // 发布成功，备份不再承担恢复作用；删不掉就打标记，交给专门的清理逻辑
  if (backupMoved) {
    try {
      removeTree(backup);
      if (fs.existsSync(backup)) throw new Error('目录仍然存在');
    } catch {
      try {
        fs.writeFileSync(`${backup}${RESOLVED_SUFFIX}`, JSON.stringify({
          id,
          resolved_at: new Date().toISOString(),
          reason: '发布成功，备份不再需要',
        }), 'utf8');
      } catch { /* 标记写不下也不影响正确性，只是多留一份垃圾 */ }
    }
  }

  store.settleClaim(id);

  return { id, dir: target, file: submission?.file || null };
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------
export function persistAssessment(args) {
  const prepared = prepare({
    imageSourceRoots: [QPATHS.attachments],
    source: 'api',
    createdAt: new Date().toISOString(),
    ...args,
  });

  const staged = stage(prepared);
  try {
    const out = publish({ id: args.id, stagedDir: staged, submission: prepared.rendered });
    return { id: out.id, file: out.file, submission: prepared.rendered.data, meta: prepared.meta };
  } finally {
    if (fs.existsSync(staged)) removeTree(staged);
  }
}

/**
 * 失败路径：只留原文和图片（meta 标 FAILED），绝不写 submissions。
 * 同样走「暂存 → 发布」，不会留下没有 meta 的半成品目录。
 */
export function persistFailure({
  id,
  task,
  topic,
  prompt,
  essay,
  imageBase64 = null,
  imagePath = null,
  imageSourceRoots = [QPATHS.attachments],
  wordCount,
  model = null,
  reason = null,
  createdAt = new Date().toISOString(),
}) {
  let image = null;
  if (imageBase64) image = decodeBase64Image(imageBase64);
  else if (imagePath) image = inspectImageFile(imagePath, imageSourceRoots);

  const body = String(essay || '');
  if (!body.trim()) {
    throw new PersistError('作文正文为空，拒绝写入失败记录', { code: 'EPERSIST_INPUT', status: 400 });
  }

  const meta = {
    id,
    created_at: createdAt,
    date: store.stamp().date,
    task: Number(task) === 1 ? 1 : 2,
    topic,
    prompt,
    word_count: wordCount,
    status: 'FAILED',
    error: reason,
    model,
  };

  const staged = stage({
    id: assertSafeId(id),
    body,
    image,
    merged: null,
    passes: null,
    revision: null,
    meta,
  });
  try {
    const out = publish({ id, stagedDir: staged, submission: null });
    return { id: out.id, meta };
  } finally {
    if (fs.existsSync(staged)) removeTree(staged);
  }
}

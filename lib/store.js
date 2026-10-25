import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import {
  PATHS,
  QPATHS,
  IMAGE_EXTS,
  assertImageSource,
  assessmentDir,
  ensureDirs,
  removeTree,
  resolveInside,
  isInside,
} from './paths.js';
import { assertSubmission } from './contract.js';
import {
  assertSafeId,
  isSafeId,
  nextId,
  releaseClaim,
  reserveId,
  reserveNamedId,
  settleClaim,
  slugify,
  stamp,
} from './ids.js';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);           // 原子替换，避免 scanner 读到半截文件
}

function safeAssessmentDir(id) {
  return assessmentDir(assertSafeId(id));
}

// ---------------------------------------------------------------------------
// 写契约文件（老看板读的就是这一个）
// ---------------------------------------------------------------------------
/**
 * 只做校验并渲染成 markdown 字符串，不碰磁盘。
 * persist 用它把「校验」和「发布」拆开：先渲染（失败就什么都别写），
 * 全部准备好以后才真正落盘。
 */
export function renderSubmission(submission, id) {
  const clean = assertSubmission(submission);
  const finalId = assertSafeId(id);
  const frontmatter = {
    date: clean.date,
    task: clean.task,
    topic: clean.topic,
    score: {
      tr: clean.score.tr,
      cc: clean.score.cc,
      lr: clean.score.lr,
      ga: clean.score.ga,
      overall: clean.score.overall,
    },
    errors: clean.errors.map((e) => ({ type: e.type, tag: e.tag, count: e.count })),
    ...(clean.word_count ? { word_count: clean.word_count } : {}),
    ...(clean.duration_min ? { duration_min: clean.duration_min } : {}),
  };

  return {
    id: finalId,
    file: `${finalId}.md`,
    path: resolveInside(PATHS.writing.submissions, `${finalId}.md`),
    content: matter.stringify(String(submission.essay || ''), frontmatter),
    data: clean,
  };
}

export function writeSubmission(submission, id) {
  // 没传 ID 才现占一个；调用方传了就必须已经占过（persist 路径如此）
  const finalId = id ? assertSafeId(id) : reserveId(submission.task, submission.topic);
  const rendered = renderSubmission(submission, finalId);
  atomicWrite(rendered.path, rendered.content);
  settleClaim(finalId);
  return { id: finalId, file: rendered.file };
}

// ---------------------------------------------------------------------------
// 评估目录
// ---------------------------------------------------------------------------
export function createAssessment(id) {
  const dir = safeAssessmentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveJSON(id, name, data) {
  const dir = createAssessment(id);
  const file = resolveInside(dir, `${name}.json`);
  atomicWrite(file, JSON.stringify(data, null, 2));
}

export function saveText(id, name, text) {
  const dir = createAssessment(id);
  const file = resolveInside(dir, name);
  atomicWrite(file, String(text ?? ''));
}

export function saveImage(id, base64) {
  if (!base64) return null;
  const dir = createAssessment(id);
  const m = /^data:image\/(\w+);base64,(.*)$/s.exec(base64);
  // 只认真正的图片 mime，别让 data:text/plain 之类落成 .png
  const mime = m ? m[1].toLowerCase() : null;
  const ext = mime === 'jpeg' ? 'jpg' : mime;
  if (!ext || !IMAGE_EXTS.includes(`.${ext}`)) {
    throw Object.assign(new Error(`图片类型不支持：${mime || '(未知)'}，只允许 ${IMAGE_EXTS.join(' / ')}`), {
      code: 'EPATH',
      status: 400,
    });
  }
  const raw = m ? m[2] : base64;
  const file = resolveInside(dir, `image.${ext}`);
  fs.writeFileSync(file, Buffer.from(raw, 'base64'));
  return `image.${ext}`;
}

/**
 * 把磁盘上的图片复制进评估目录。
 * 源路径、目标路径、图片类型三样都要过：
 * 源必须在 allowRoots 之内（队列附件目录 / 复核存档目录），类型必须是图片。
 */
export function saveImageFromFile(id, srcPath, { allowRoots = [] } = {}) {
  if (!srcPath) return null;
  const { src, ext } = assertImageSource(srcPath, allowRoots);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return null;
  const dir = createAssessment(id);
  const target = resolveInside(dir, `image${ext}`);
  if (path.resolve(src) !== path.resolve(target)) fs.copyFileSync(src, target);
  return path.basename(target);
}

export function appendChat(id, message) {
  const dir = createAssessment(id);
  fs.appendFileSync(resolveInside(dir, 'chat.jsonl'), `${JSON.stringify(message)}\n`, 'utf8');
}

export function readChat(id) {
  const file = resolveInside(assessmentDir(assertSafeId(id)), 'chat.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

export function readMeta(id) {
  if (!isSafeId(id)) return null;
  const file = resolveInside(assessmentDir(id), 'meta.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function readJSON(id, name) {
  if (!isSafeId(id)) return null;
  const file = resolveInside(assessmentDir(id), `${name}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function readText(id, name) {
  if (!isSafeId(id)) return null;
  const file = resolveInside(assessmentDir(id), name);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

export function listAssessments() {
  ensureDirs();
  const dirs = fs.readdirSync(PATHS.writing.assessments, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    // 目录名是外部可写的：不合规的直接跳过，别让一条垃圾目录拖垮整个列表
    .filter(isSafeId);
  const items = dirs
    .map((id) => readMeta(id))
    .filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return items;
}

export function getAssessment(id) {
  if (!isSafeId(id)) return null;
  const meta = readMeta(id);
  if (!meta) return null;
  return {
    meta,
    merged: readJSON(id, 'merged'),
    passes: readJSON(id, 'passes'),
    original: readText(id, 'original.md'),
    revised: readText(id, 'revised.md'),
    chat: readChat(id),
  };
}

export function deleteAssessment(id) {
  if (!isSafeId(id)) return false;
  const meta = readMeta(id);
  const dir = assessmentDir(id);
  if (fs.existsSync(dir)) removeTree(dir);
  // 同步删掉契约文件，否则老看板还留着一行
  if (meta?.submission_file) {
    const f = path.resolve(PATHS.writing.submissions, meta.submission_file);
    if (isInside(PATHS.writing.submissions, f) && fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  releaseClaim(id);
  return true;
}

export { stamp, nextId, slugify, reserveId, reserveNamedId, settleClaim, releaseClaim };

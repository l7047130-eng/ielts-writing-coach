import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// 与 ielts-dashboard 共用同一个数据根目录
export const IELTS_HOME = process.env.IELTS_HOME || path.join(os.homedir(), '.ielts');

export const PATHS = {
  home: IELTS_HOME,
  writing: {
    // 契约文件：老看板的 scanner 只扫这个目录
    submissions: path.join(IELTS_HOME, 'writing', 'submissions'),
    // 本工具的完整数据（点评、改写、对话、图片、原始响应）
    assessments: path.join(IELTS_HOME, 'writing', 'assessments'),
  },
};

// 文件队列的目录定义放这里（而不是 queue.js），
// 这样 ids.js 不必反过来依赖 queue.js，避免循环 import。
const QUEUE_ROOT = path.join(IELTS_HOME, 'writing', 'queue');
export const QPATHS = {
  root: QUEUE_ROOT,
  pending: path.join(QUEUE_ROOT, 'pending'),
  done: path.join(QUEUE_ROOT, 'done'),
  failed: path.join(QUEUE_ROOT, 'failed'),
  attachments: path.join(QUEUE_ROOT, 'attachments'),
  // ID 占位文件：入队/开批前先原子占位，避免同名覆盖
  claims: path.join(QUEUE_ROOT, 'claims'),
  // 已导入标记：任务清掉后仍能回答「这个 id 导入到哪条记录了」，让 ingest 幂等
  imported: path.join(QUEUE_ROOT, 'imported'),
};

// ---------------------------------------------------------------------------
// 路径边界：任何由外部输入（URL 参数、body、文件名）拼出的路径都要过这里
// ---------------------------------------------------------------------------
export function isInside(root, target) {
  const base = path.resolve(root);
  const p = path.resolve(target);
  return p === base || p.startsWith(base + path.sep);
}

/**
 * 在 root 之内解析若干段路径。越界直接抛错，绝不返回。
 * Windows 下 path.resolve 会把 `..\x` 正确折叠，随后由 isInside 判定。
 */
export function resolveInside(root, ...parts) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts.map((p) => String(p ?? '')));
  if (!isInside(base, target)) {
    throw Object.assign(new Error(`路径越界，已拒绝：${parts.map(String).join('/')}`), { code: 'EPATH' });
  }
  return target;
}

/** 断言 target 在 root 之内，返回归一化后的绝对路径 */
export function assertInside(root, target) {
  const p = path.resolve(String(target ?? ''));
  if (!isInside(root, p)) {
    throw Object.assign(new Error(`路径越界，已拒绝：${target}`), { code: 'EPATH' });
  }
  return p;
}

export function assessmentDir(id) {
  return resolveInside(PATHS.writing.assessments, id);
}

export function submissionFile(id) {
  return resolveInside(PATHS.writing.submissions, `${id}.md`);
}

export function queueFile(bucket, id) {
  return resolveInside(QPATHS[bucket], `${id}.json`);
}

export function ensureDirs() {
  for (const dir of [PATHS.writing.submissions, PATHS.writing.assessments]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// 图片类型白名单
// 复制/写入图片前同时校验来源目录、目标目录和扩展名，
// 免得 body.imagePath 之类的入口被用来把任意本地文件搬进数据目录。
// ---------------------------------------------------------------------------
export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

export function imageExtOf(p) {
  const ext = path.extname(String(p || '')).toLowerCase();
  return IMAGE_EXTS.includes(ext) ? ext : null;
}

/** 源路径必须在允许的目录之内，且是图片类型 */
export function assertImageSource(srcPath, allowRoots) {
  const src = path.resolve(String(srcPath || ''));
  const roots = (Array.isArray(allowRoots) ? allowRoots : []).filter(Boolean);
  if (roots.length === 0) {
    throw Object.assign(new Error('图片来源目录未指定，拒绝复制'), { code: 'EPATH', status: 400 });
  }
  const inside = roots.some((r) => isInside(r, src));
  if (!inside) {
    throw Object.assign(
      new Error(`图片来源目录不合法，已拒绝：${srcPath}`),
      { code: 'EPATH', status: 400 }
    );
  }
  const ext = imageExtOf(src);
  if (!ext) {
    throw Object.assign(
      new Error(`图片类型不支持：${path.extname(src) || '(无扩展名)'}，只允许 ${IMAGE_EXTS.join(' / ')}`),
      { code: 'EPATH', status: 400 }
    );
  }
  return { src, ext };
}

// ---------------------------------------------------------------------------
// 删目录
// 不用 fs.rmSync(recursive)：Windows 上刚写完的文件常有句柄延迟（EBUSY / ENOTEMPTY），
// 递归删除会整块失败。逐文件删 + 重试，单个文件删不掉也不影响其它文件。
// ---------------------------------------------------------------------------
const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* 不支持就忙等 */ }
};

export function removeTree(dir, tries = 3) {
  const target = path.resolve(String(dir));
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (!fs.existsSync(target)) return true;
    walkRemove(target);
    try { fs.rmdirSync(target); } catch { /* 下一轮再来 */ }
    if (!fs.existsSync(target)) return true;
    sleepSync(40);
  }
  return !fs.existsSync(target);
}

function walkRemove(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        walkRemove(p);
        fs.rmdirSync(p);
      } else {
        fs.unlinkSync(p);
      }
    } catch { /* 单个节点失败留在下一轮重试 */ }
  }
}

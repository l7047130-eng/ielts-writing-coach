import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_EXTS, QPATHS, queueFile, resolveInside } from './paths.js';
import { assertSafeId, isSafeId, releaseClaim, settleClaim } from './ids.js';

// ---------------------------------------------------------------------------
// 本地文件队列：网站写 pending/，AI 读 pending 写 done/，网站读 done 落盘
// 目录放在 ~/.ielts/writing/queue/，与 assessments 同级
// ---------------------------------------------------------------------------
export { QPATHS };

// AI 侧不是原子写，可能先看到半截内容。这个窗口内读不出来算「正在写」，不算失败。
export const WRITE_GRACE_MS = 3000;

export function ensureQueueDirs() {
  for (const dir of Object.values(QPATHS)) fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJSONFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** mtime+size 指纹：文件没被换过就是同一份 */
function stampOf(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}-${st.size}`;
  } catch {
    return null;
  }
}

export function attachmentPath(id, ext = '.jpg') {
  ensureQueueDirs();
  return resolveInside(QPATHS.attachments, `${assertSafeId(id)}${ext}`);
}

export function saveAttachment(id, base64) {
  if (!base64) return null;
  const m = /^data:image\/(\w+);base64,(.*)$/s.exec(base64);
  const mime = m ? m[1].toLowerCase() : null;
  const ext = mime === 'jpeg' ? 'jpg' : mime;
  // 只认真正的图片 mime，落盘文件名也不会跟着输入乱变
  if (!ext || !IMAGE_EXTS.includes(`.${ext}`)) {
    throw Object.assign(
      new Error(`图片类型不支持：${mime || '(未知)'}，只允许 ${IMAGE_EXTS.join(' / ')}`),
      { code: 'EPATH', status: 400 }
    );
  }
  const raw = m ? m[2] : base64;
  const file = attachmentPath(id, `.${ext}`);
  fs.writeFileSync(file, Buffer.from(raw, 'base64'));
  return file;
}

/**
 * 入队。ID 必须由调用方先 reserveId 占好；这里再兜一层：文件已存在就报错，
 * 绝不静默覆盖（覆盖等于丢正文）。
 */
export function enqueue(payload) {
  ensureQueueDirs();
  const id = assertSafeId(payload?.id, '任务 id');
  const file = queueFile('pending', id);
  if (fs.existsSync(file)) {
    throw Object.assign(new Error(`队列里已经有 ${id}，拒绝覆盖`), { code: 'EEXIST_ID', status: 409 });
  }
  atomicWrite(file, { ...payload, id });
  settleClaim(id);          // pending 文件本身已经在守门，占位可以撤
  return file;
}

/**
 * 读 done 文件并分类。
 * absent    没有文件
 * writing   有文件但读不出 / 空 / 刚写完（mtime 在宽容窗口内）
 * invalid   有文件、读不出、且已经过了宽容窗口 → 确定失败
 * ready     合法 JSON 对象
 */
export function inspectDone(id, { now = Date.now() } = {}) {
  const safe = assertSafeId(id);
  const file = queueFile('done', safe);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { state: 'absent', file };
  }
  const stamp = `${st.mtimeMs}-${st.size}`;
  const ageMs = Math.max(0, now - st.mtimeMs);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { state: 'unreadable', file, ageMs, stamp, reason: `读不动结果文件：${e.message}` };
  }
  if (!raw.trim()) {
    return ageMs < WRITE_GRACE_MS
      ? { state: 'writing', file, ageMs, stamp, reason: '结果文件是空的' }
      : { state: 'invalid', file, ageMs, stamp, reason: '结果文件是空的' };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return ageMs < WRITE_GRACE_MS
      ? { state: 'writing', file, ageMs, stamp, reason: `JSON 还没写完整（${e.message}）` }
      : { state: 'invalid', file, ageMs, stamp, reason: `结果文件不是合法 JSON：${e.message}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { state: 'invalid', file, ageMs, stamp, reason: '结果文件的顶层不是 JSON 对象' };
  }
  return { state: 'ready', file, ageMs, stamp, data };
}

export function readFailed(id) {
  if (!isSafeId(id)) return null;
  return readJSONFile(queueFile('failed', id));
}

// ---------------------------------------------------------------------------
// 已导入标记：任务文件清掉后，仍能回答「这个队列 id 落到哪条记录了」
// 多页面同时轮询时，第二次 ingest 靠它返回同一条记录，而不是报 404 或重复写
// ---------------------------------------------------------------------------
export function markImported(id, assessmentId) {
  const safe = assertSafeId(id);
  ensureQueueDirs();
  const file = queueFile('imported', safe);
  atomicWrite(file, { id: safe, assessment_id: assessmentId, at: new Date().toISOString() });
  return file;
}

export function readImported(id) {
  if (!isSafeId(id)) return null;
  return readJSONFile(queueFile('imported', id));
}

export function clearImported(id) {
  if (!isSafeId(id)) return false;
  const f = queueFile('imported', id);
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  return true;
}

/**
 * 任务状态。
 * 判定顺序很关键：
 *  1. 已经判过失败，且 done 文件没变过（同 mtime + 同 size）→ 一直报 failed，
 *     否则前端会永远在「done → ingest 422 → 还是 done」之间打转。
 *  2. done 合法 → done。用户换过一份结果时这里会重新给一次机会。
 *  3. 正在写 → pending + note。
 *  4. 坏文件且过了宽容窗口 → 明确 failed。
 *  5. 只有失败标记 → failed。
 *  6. 已导入 / 等待中 / 不存在。
 */
export function getStatus(id) {
  ensureQueueDirs();
  const safe = assertSafeId(id);
  const pending = readPending(safe);
  const done = inspectDone(safe);
  const failed = readFailed(safe);

  const failedStatus = (src) => ({
    status: 'failed',
    resultState: done.state === 'ready' ? 'rejected' : (done.state === 'invalid' ? 'invalid' : 'absent'),
    pending,
    failure: {
      kind: src.kind || 'rejected',
      reason: src.reason || '结果校验没通过',
      warnings: src.warnings?.length ? src.warnings : [src.reason || '结果校验没通过'],
      failed_at: src.failed_at || null,
      source: src.source || 'ingest',
    },
  });

  // 1) 同一个结果已经判过失败，且任务文件也没换过：不再假装 done
  const sameDone = failed?.done_stamp && done.stamp && failed.done_stamp === done.stamp;
  const samePending = !failed?.pending_stamp
    || failed.pending_stamp === stampOf(queueFile('pending', safe));
  if (sameDone && samePending) {
    return failedStatus(failed);
  }

  if (done.state === 'ready') {
    return { status: 'done', resultState: 'ready', pending, result: done.data };
  }

  if (done.state === 'writing' || done.state === 'unreadable') {
    // 可能是 agent 正在写，也可能刚写完还没 flush。继续等，但把话说清楚。
    return {
      status: 'pending',
      resultState: 'writing',
      pending,
      note: done.reason || '结果文件正在写入',
    };
  }

  if (done.state === 'invalid') {
    return failedStatus({
      kind: 'invalid-json',
      reason: done.reason,
      warnings: [done.reason],
      source: 'done-file',
      failed_at: new Date().toISOString(),
    });
  }

  if (failed) return failedStatus(failed);

  const imported = readImported(safe);
  if (imported?.assessment_id) {
    return { status: 'imported', resultState: 'ready', imported, assessment_id: imported.assessment_id };
  }

  if (pending) return { status: 'pending', resultState: 'absent', pending };
  return { status: 'missing', resultState: 'absent' };
}

export function readDone(id) {
  return readJSONFile(queueFile('done', assertSafeId(id)));
}

export function readPending(id) {
  if (!isSafeId(id)) return null;
  return readJSONFile(queueFile('pending', id));
}

export function markFailed(id, reason, extra = {}) {
  ensureQueueDirs();
  const safe = assertSafeId(id);
  const done = inspectDone(safe);
  const payload = {
    id: safe,
    kind: extra.kind || 'rejected',
    reason: String(reason || '结果校验没通过').slice(0, 2000),
    warnings: Array.isArray(extra.warnings) ? extra.warnings.slice(0, 20) : [],
    source: extra.source || 'ingest',
    failed_at: new Date().toISOString(),
    // 记下被判失败的那份结果：用户换掉文件后（指纹变了）就重新给一次机会
    done_stamp: done.stamp || null,
    // 任务文件也可能被修正（比如改 image_path），改过就重新放行
    pending_stamp: stampOf(queueFile('pending', safe)),
    pending: readPending(safe) ? summarizePending(readPending(safe)) : null,
  };
  atomicWrite(queueFile('failed', safe), payload);
  return payload;
}

// failed/ 里不必留整段 instruction，太占地
function summarizePending(p) {
  const { instruction, ...rest } = p || {};
  return { ...rest, instruction_chars: instruction ? String(instruction).length : 0 };
}

// 处理成功后清掉 pending / done / failed / 占位，数据已经进 assessments 了
export function clearTask(id) {
  const safe = assertSafeId(id);
  for (const bucket of ['pending', 'done', 'failed']) {
    const f = queueFile(bucket, safe);
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  // 附件也删掉：assessments 里已经有一份副本
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.gif']) {
    const f = path.resolve(QPATHS.attachments, `${safe}${ext}`);
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  releaseClaim(safe);
}

export function listPending() {
  ensureQueueDirs();
  return fs.readdirSync(QPATHS.pending)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map((f) => {
      const j = readJSONFile(path.resolve(QPATHS.pending, f));
      if (!j) return null;
      const id = isSafeId(j.id) ? j.id : f.replace(/\.json$/, '');
      if (!isSafeId(id)) return null;
      const ageHours = (Date.now() - new Date(j.created_at).getTime()) / 3600000;
      // 顺带给出状态：侧栏要显示「有结果」还是「失败了」，不能只看文件在不在
      const st = getStatus(id);
      return {
        id,
        kind: j.kind || 'full',
        task: j.task,
        topic: j.topic || '',
        created_at: j.created_at,
        age_hours: Number(ageHours.toFixed(1)),
        stale: ageHours > 24,
        chars: j.instruction ? String(j.instruction).length : 0,
        assessment_id: j.assessment_id || null,
        state: st.status,
        has_result: st.status === 'done',
        failed: st.status === 'failed',
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

// 给用户复制的那句触发提示。指令本身在文件里，这里只说去哪读、写到哪
export function triggerHint() {
  return '跑一下写作批改队列：读 ~/.ielts/writing/queue/pending/ 下的每个 json，按文件里 instruction 字段的要求完成批改，结果写到该文件 output_path 指定的位置。';
}

export const REVIEW_HINT = '复核要在新对话里跑：模型看不见自己上一次的结论，才算独立评分。跑完照旧把结果写到 output_path。';

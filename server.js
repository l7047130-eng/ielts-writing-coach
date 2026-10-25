import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IELTS_HOME, IMAGE_EXTS, assertInside, assessmentDir, ensureDirs } from './lib/paths.js';
import { isSafeId, assertSafeId } from './lib/ids.js';
import { DEFAULT_HOSTS, allowedHosts, allowedOrigins, isTrustedHost, originDecision, ORIGIN_REJECTED } from './lib/security.js';
import { chat, chatStream, llmConfig, listModels, testConnection } from './lib/llm.js';
import { getSettings, publicSettings, saveSettings, missingFields } from './lib/settings.js';
import { buildChatMessages, buildManualPrompt, buildReviseMessages, buildReviewPrompt } from './lib/prompts.js';
import { combineResults, finalizeResults, gradePass } from './lib/grading.js';
import { parseQueueResult } from './lib/manual.js';
import { persistAssessment, persistFailure } from './lib/persist.js';
import * as queue from './lib/queue.js';
import * as store from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4100;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();

// ---------------------------------------------------------------------------
// Host 必须是配置允许的服务地址
// 光在 CORS 的同源分支里校验 Host 不够：DNS rebinding 或直连 API 的伪造 Host
// 同样不该拿到数据。本地工具，Host 不可信就是异常，直接拒。
// 其它部署地址（局域网 IP / 内网域名）用 ALLOWED_HOSTS 显式配置。
// ---------------------------------------------------------------------------
const ORIGINS = allowedOrigins();
const HOSTS = allowedHosts();

app.use((req, res, next) => {
  const host = req.get('host');
  if (!isTrustedHost(host, HOSTS)) {
    return res.status(403).json({
      error: `Host 不被允许：${host || '(空)'}。默认只接受 ${[...DEFAULT_HOSTS].join(' / ')}，其它部署地址请设置 ALLOWED_HOSTS。`,
    });
  }
  return next();
});

// ---------------------------------------------------------------------------
// CORS：精确来源白名单 + 受信任 Host 才认同源
// 以前用 /localhost|127\.0\.0\.1/ 正则，https://localhost.attacker.example 也能过。
// 后来改成精确比对，但同源分支直接拿请求的 Host 拼 selfOrigin，
// 客户端把 Host 和 Origin 都设成 attacker.example 就能自证可信（已复现）。
// 现在：Host 必须属于允许的服务地址，同源放行才成立。
// ---------------------------------------------------------------------------
app.use(cors((req, cb) => {
  const origin = req.headers.origin || null;
  const hostHeader = req.get('host');
  const hostAllowed = isTrustedHost(hostHeader, HOSTS);
  const selfOrigin = hostAllowed ? `${req.protocol}://${hostHeader}` : null;
  const { allowed, reason } = originDecision({ origin, selfOrigin, hostAllowed, set: ORIGINS });
  if (!allowed) {
    const err = new Error(`来源不被允许：${origin}（Host=${hostHeader || '无'}，${reason}）`);
    err.code = ORIGIN_REJECTED;
    err.origin = origin;
    return cb(err);
  }
  return cb(null, { origin: origin || true, credentials: false });
}));
// 图片走 base64，给足额度。另外全局不要加 compression，它会缓冲 SSE。
app.use(express.json({ limit: '16mb' }));

ensureDirs();

/** 把「id 不合法」这类可预期错误映射成 400，其余交给统一错误处理 */
function fail(res, e) {
  const status = e?.status || (e?.code === 'EID' || e?.code === 'EPATH' ? 400 : 500);
  if (status >= 500) console.error('[server]', e);
  return res.status(status).json({
    error: e?.message || '服务器错误',
    ...(e?.code ? { code: e.code } : {}),
    ...(Array.isArray(e?.warnings) ? { warnings: e.warnings } : {}),
    // 回滚失败时把「备份在哪、恢复到哪」原样透出，别让用户自己猜
    ...(e?.recovery ? { recovery: e.recovery } : {}),
  });
}

function badId(res) {
  return res.status(400).json({
    error: 'id 不合法：只允许字母、数字、下划线、点和短横线，不能包含路径分隔符或 ..',
  });
}

// ---------------------------------------------------------------------------
// SSE 管道
// ---------------------------------------------------------------------------
function openSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  req.socket.setNoDelay(true);      // 否则 Nagle 把小块攒到 40ms 才发
  req.socket.setTimeout(0);

  const ac = new AbortController();
  // 必须监听 res 而不是 req：POST body 读完 req 就会触发 close
  res.on('close', () => ac.abort());

  const send = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => send('ping', { t: Date.now() }), 15000);

  return {
    send,
    signal: ac.signal,
    close() {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
  };
}

const countWords = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

// 改写稿体检：太短、长度离谱、或吐了一坨 JSON，都当失败处理。
// 宁可不给改写，也不要给一份会误导人的稿子。
function revisionLooksSane(text, essay) {
  const t = String(text || '').trim();
  if (!t || t.startsWith('{')) return false;
  const rw = countWords(t);
  const ew = countWords(essay);
  if (ew >= 80 && rw < 40) return false;
  if (ew > 40 && (rw < ew * 0.5 || rw > ew * 1.8)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 健康检查 + 模型配置（界面里填，不碰文件）
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ielts_home: IELTS_HOME,
    ...publicSettings(),
    missing: missingFields(),
  });
});

app.get('/api/settings', (_req, res) => {
  res.json(publicSettings());
});

app.put('/api/settings', (req, res) => {
  const { mode, base, key, model } = req.body || {};
  const nextMode = mode || getSettings().mode;
  // 只有 API 模式才要求接口凭据；队列和粘贴模式完全不碰模型接口
  if (nextMode === 'api' && (!base || !model)) {
    return res.status(400).json({ error: 'API 模式下接口地址和模型名必填' });
  }
  saveSettings({ mode: nextMode, base, key, model });
  res.json(publicSettings());
});

app.post('/api/settings/test', async (req, res) => {
  try {
    res.json(await testConnection(req.body || {}));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings/models', async (req, res) => {
  try {
    res.json({ models: await listModels(req.body || {}) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// 文件队列：网站入队 → AI 写结果 → 网站落盘
// 指令跟着任务走（写进 pending.instruction），AI 侧不需要知道任何评分逻辑
// ---------------------------------------------------------------------------
app.get('/api/queue', (_req, res) => {
  try {
    res.json({ items: queue.listPending(), trigger: queue.triggerHint(), dir: queue.QPATHS.root });
  } catch (e) {
    fail(res, e);
  }
});

/** 复核任务：材料一律取服务端存档，不信客户端重交的正文 / 图片 */
function buildReviewTask(body) {
  let assessmentId;
  try {
    assessmentId = assertSafeId(String(body.id || ''), '评估 id');
  } catch (e) {
    throw Object.assign(new Error('发起复核需要一个合法的记录 id'), { status: 400 });
  }

  const detail = store.getAssessment(assessmentId);
  if (!detail) throw Object.assign(new Error('没有这条记录，无法复核'), { status: 404 });
  if (!detail.passes?.a?.data) {
    throw Object.assign(new Error('这条记录没有原始评分，无法复核'), { status: 409 });
  }

  const meta = detail.meta;
  const essay = detail.original || '';
  if (!String(essay).trim()) {
    throw Object.assign(new Error('这条记录没有留存原文，无法复核'), { status: 409 });
  }

  // 图片从评估目录里找（image.jpg / image.png / …），沿用原图。
  // 来源只允许这条记录自己的评估目录：复核存档图不接受外部路径。
  let imagePath = null;
  const dir = assessmentDir(assessmentId);
  for (const ext of IMAGE_EXTS) {
    const f = path.join(dir, `image${ext}`);
    if (!fs.existsSync(f)) continue;
    assertInside(dir, f);          // 防御：路径必须落在这条记录的目录里
    imagePath = f;
    break;
  }

  const task = Number(meta.task) === 1 ? 1 : 2;
  const wordCount = meta.word_count || countWords(essay);
  const id = store.reserveNamedId(`review-${assessmentId}`, { assessment_id: assessmentId });
  const outputPath = path.join(queue.QPATHS.done, `${id}.json`);

  const instruction = buildReviewPrompt({
    task,
    prompt: meta.prompt || '',
    essay,
    wordCount,
    hasImage: Boolean(imagePath),
    imagePath,
    outputPath,
    id,
  });

  return {
    id,
    assessment_id: assessmentId,
    payload: {
      id,
      kind: 'review',
      assessment_id: assessmentId,
      created_at: new Date().toISOString(),
      task,
      topic: meta.topic || 'review',
      prompt: meta.prompt || '',
      essay,
      word_count: wordCount,
      duration_min: meta.duration_min || null,
      image_path: imagePath,
      output_path: outputPath,
      instruction,
    },
  };
}

app.post('/api/queue', (req, res) => {
  const body = req.body || {};

  if (body.kind === 'review') {
    let built;
    try {
      built = buildReviewTask(body);
    } catch (e) {
      return fail(res, e);
    }
    try {
      queue.enqueue(built.payload);
    } catch (e) {
      store.releaseClaim(built.id);
      return fail(res, e);
    }
    return res.json({
      id: built.id,
      assessment_id: built.assessment_id,
      kind: 'review',
      chars: built.payload.instruction.length,
      output_path: built.payload.output_path,
      trigger: queue.triggerHint(),
      hint: queue.REVIEW_HINT,
    });
  }

  const task = Number(body.task);
  const essay = String(body.essay || '').trim();
  const prompt = String(body.prompt || '').trim();
  const topic = String(body.topic || '').trim() || prompt.slice(0, 40) || 'essay';

  if (![1, 2].includes(task)) return res.status(400).json({ error: 'task 必须是 1 或 2' });
  if (!essay) return res.status(400).json({ error: '作文内容不能为空' });

  // 图片只走 base64 上传（前端 ImageDrop 就是这么发的）。
  // 不接受客户端指定本地 imagePath：那是服务端生成的附件路径，
  // 放进来等于让任意本地文件被读进数据目录（已复现）。
  // 校验必须放在占位之前，否则占位会泄漏。
  if (body.imagePath) {
    return res.status(400).json({
      error: '不接受 imagePath 参数。图片请用 imageBase64 上传，或让服务端自己生成附件路径。',
    });
  }

  // 关键：先原子占位，再写文件。占位覆盖 pending / done / failed / 并发请求。
  let id;
  try {
    id = store.reserveId(task, topic);
  } catch (e) {
    return fail(res, e);
  }

  try {
    const wordCount = countWords(essay);
    const imageFile = body.imageBase64
      ? queue.saveAttachment(id, String(body.imageBase64))
      : null;
    const outputPath = path.join(queue.QPATHS.done, `${id}.json`);

    const instruction = buildManualPrompt({
      task,
      prompt,
      essay,
      wordCount,
      hasImage: Boolean(imageFile),
      imagePath: imageFile,
      outputPath,
      id,
    });

    queue.enqueue({
      id,
      kind: 'full',
      created_at: new Date().toISOString(),
      task,
      topic,
      prompt,
      essay,
      word_count: wordCount,
      duration_min: body.duration_min ? Number(body.duration_min) : null,
      image_path: imageFile || null,
      output_path: outputPath,
      instruction,
    });

    res.json({
      id,
      kind: 'full',
      chars: instruction.length,
      output_path: outputPath,
      trigger: queue.triggerHint(),
    });
  } catch (e) {
    store.releaseClaim(id);
    fail(res, e);
  }
});

app.get('/api/queue/:id', (req, res) => {
  const { id } = req.params;
  if (!isSafeId(id)) return badId(res);
  try {
    const st = queue.getStatus(id);
    if (st.status === 'missing') return res.status(404).json({ error: '队列里没有这个任务' });
    // 不回传整段 instruction，前端用不到
    if (st.pending?.instruction) delete st.pending.instruction;
    if (st.failure?.pending?.instruction) delete st.failure.pending.instruction;
    res.json(st);
  } catch (e) {
    fail(res, e);
  }
});

// 取消：把任务从队列里彻底删掉，避免以后被误处理
app.delete('/api/queue/:id', (req, res) => {
  const { id } = req.params;
  if (!isSafeId(id)) return badId(res);
  try {
    queue.clearTask(id);
    queue.clearImported(id);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// ---------------------------------------------------------------------------
// ingest：同一个 id 串行处理，多页面同时轮询不会重复落盘
// ---------------------------------------------------------------------------
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.finally(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

function ingestFull(queueId, pending, payload, fromPaste) {
  const parsed = parseQueueResult(payload, { essay: pending.essay || '', kind: 'full' });
  if (!parsed.passA) {
    const reason = parsed.warnings.join('；') || '解析失败';
    queue.markFailed(queueId, reason, { kind: 'rejected', warnings: parsed.warnings });
    return {
      status: 422,
      body: { error: '结果无法解析或不合格，未写入看板', warnings: parsed.warnings, result_state: 'rejected' },
    };
  }

  const merged = finalizeResults(parsed.passA, parsed.passB);
  const passes = {
    a: { data: parsed.passA, overall: merged.pass_overall[0] },
    ...(parsed.passB ? { b: { data: parsed.passB, overall: merged.pass_overall[1] } } : {}),
  };

  persistAssessment({
    id: queueId,
    task: pending.task,
    topic: pending.topic,
    prompt: pending.prompt,
    essay: pending.essay,
    imagePath: pending.image_path || null,
    wordCount: pending.word_count,
    durationMin: pending.duration_min,
    merged,
    passes,
    revision: parsed.revision,
    source: fromPaste ? 'paste' : 'queue',
    model: null,
    createdAt: pending.created_at,
  });

  queue.markImported(queueId, queueId);
  queue.clearTask(queueId);

  return {
    status: 200,
    body: {
      id: queueId,
      detail: store.getAssessment(queueId),
      warnings: parsed.warnings,
      missing: parsed.missing,
    },
  };
}

function ingestReview(queueId, pending, payload) {
  const assessmentId = pending.assessment_id;
  if (!isSafeId(String(assessmentId || ''))) {
    const reason = '复核任务缺少合法的 assessment_id，拒绝写入';
    queue.markFailed(queueId, reason, { kind: 'bad-task' });
    return { status: 409, body: { error: reason, warnings: [reason] } };
  }

  const prevPasses = store.readJSON(assessmentId, 'passes');
  const prevMeta = store.readMeta(assessmentId);
  const prevOriginal = store.readText(assessmentId, 'original.md');
  if (!prevPasses?.a?.data || !prevMeta) {
    const reason = '找不到原始评分记录，无法复核';
    queue.markFailed(queueId, reason, { kind: 'bad-task' });
    return { status: 409, body: { error: reason, warnings: [reason] } };
  }

  // 用存档原文做引用校验，不用客户端提交的那份
  const parsed = parseQueueResult(payload, { essay: prevOriginal || '', kind: 'review' });
  if (!parsed.passB) {
    const reason = parsed.warnings.join('；') || '复核结果无法解析';
    queue.markFailed(queueId, reason, { kind: 'rejected', warnings: parsed.warnings });
    return {
      status: 422,
      body: { error: '复核结果不合格，未写入看板', warnings: parsed.warnings, result_state: 'rejected' },
    };
  }

  const merged = combineResults(prevPasses.a.data, parsed.passB);
  const passes = {
    a: prevPasses.a,
    b: { data: parsed.passB, overall: merged.pass_overall[1] },
  };

  // 原文、题目、图片、用时、对话全部沿用存档，概不接受客户端重交
  persistAssessment({
    id: assessmentId,
    task: prevMeta.task,
    topic: prevMeta.topic,
    prompt: prevMeta.prompt,
    essay: prevOriginal || '',
    imageBase64: null,
    imagePath: null,
    wordCount: prevMeta.word_count,
    durationMin: prevMeta.duration_min,
    merged,
    passes,
    revision: null,               // 不覆盖已有的改写稿
    source: prevMeta.source || 'queue',
    model: prevMeta.model || null,
    createdAt: prevMeta.created_at,
    date: prevMeta.date,
    metaExtra: {
      reviewed_at: new Date().toISOString(),
      review_count: Number(prevMeta.review_count || 0) + 1,
    },
  });

  queue.markImported(queueId, assessmentId);
  queue.clearTask(queueId);

  return {
    status: 200,
    body: {
      id: assessmentId,
      detail: store.getAssessment(assessmentId),
      warnings: parsed.warnings,
      reviewed: true,
      spread: merged.spread,
      pass_overall: merged.pass_overall,
    },
  };
}

async function ingestOnce(queueId, body) {
  const pending = queue.readPending(queueId);

  if (!pending) {
    // 幂等：上次已经导入过，直接把现有记录还回去
    const imported = queue.readImported(queueId);
    if (imported?.assessment_id && isSafeId(imported.assessment_id)) {
      const existing = store.getAssessment(imported.assessment_id);
      if (existing) {
        return {
          status: 200,
          body: { id: imported.assessment_id, detail: existing, warnings: [], already: true },
        };
      }
    }
    return { status: 404, body: { error: '队列里没有这个任务（可能已经导入过了）' } };
  }

  const kind = pending.kind === 'review' ? 'review' : 'full';
  const pasted = String(body.reply || '').trim();

  let payload;
  if (pasted) {
    payload = pasted;
  } else {
    const done = queue.inspectDone(queueId);
    if (done.state === 'absent') {
      return {
        status: 409,
        body: {
          error: '还没有结果文件。先让协助者跑一次队列，或者把回复粘进来',
          result_state: 'absent',
        },
      };
    }
    if (done.state !== 'ready') {
      queue.markFailed(queueId, done.reason, {
        kind: done.state === 'writing' ? 'pending-write' : 'invalid-json',
        warnings: [done.reason],
        source: 'done-file',
      });
      return {
        status: 422,
        body: { error: done.reason, warnings: [done.reason], result_state: done.state },
      };
    }
    payload = done.data;
  }

  return kind === 'review'
    ? ingestReview(queueId, pending, payload)
    : ingestFull(queueId, pending, payload, Boolean(pasted));
}

app.post('/api/queue/:id/ingest', async (req, res) => {
  const { id } = req.params;
  if (!isSafeId(id)) return badId(res);
  try {
    const out = await withLock(id, () => ingestOnce(id, req.body || {}));
    return res.status(out.status).json(out.body);
  } catch (e) {
    // 落盘失败必须让队列离开 done：否则页面一直看到「有结果」，
    // 重试也永远拿到同一个错误，而磁盘上已经有了半成品。
    // pending 保留，修好材料（图片路径 / 结果内容）后可以直接重试。
    const message = e?.message || '落盘失败';
    try {
      const rollbackFailed = e?.code === 'EPERSIST_ROLLBACK_FAILED';
      queue.markFailed(id, message, {
        kind: rollbackFailed ? 'rollback-failed' : (e?.code === 'EPERSIST_PUBLISH' ? 'persist-failed' : 'rejected'),
        warnings: e?.recovery
          ? [message, `完整备份：${e.recovery.backupPath}`, `恢复方式：${e.recovery.restoreHint}`]
          : [message],
        source: 'ingest',
      });
    } catch (markErr) {
      console.error('[ingest] 标记失败状态时出错:', markErr.message);
    }
    return fail(res, e);
  }
});

// ---------------------------------------------------------------------------
// 批改
// ---------------------------------------------------------------------------
app.post('/api/grade', async (req, res) => {
  const body = req.body || {};
  const task = Number(body.task);
  const essay = String(body.essay || '').trim();
  const prompt = String(body.prompt || '').trim();
  const imageBase64 = body.imageBase64 ? String(body.imageBase64) : null;
  const topic = String(body.topic || '').trim() || prompt.slice(0, 40) || 'essay';

  if (![1, 2].includes(task)) {
    return res.status(400).json({ error: 'task 必须是 1 或 2' });
  }
  if (!essay) {
    return res.status(400).json({ error: '作文内容不能为空' });
  }
  if (task === 1 && !imageBase64) {
    return res.status(400).json({ error: 'Task 1 需要上传题目图片（图表靠多模态模型读）' });
  }

  // 先占 ID 再开 SSE：并发批改也不会撞车
  let id;
  try {
    id = store.reserveId(task, topic);
  } catch (e) {
    return fail(res, e);
  }

  const sse = openSSE(req, res);
  const wordCount = countWords(essay);
  const images = imageBase64 ? [imageBase64] : [];

  try {
    sse.send('start', { id, task, wordCount, topic });

    const failures = [];
    const runTask = async (name, fn) => {
      sse.send('task', { id: name, status: 'running' });
      const t0 = Date.now();
      try {
        const value = await fn();
        sse.send('task', { id: name, status: 'ok', ms: Date.now() - t0, score: value?.overall });
        return value;
      } catch (e) {
        if (sse.signal.aborted) throw new Error('已取消');
        failures.push({ id: name, message: e.message });
        sse.send('task', { id: name, status: 'fail', message: e.message });
        console.error(`[grade] ${name} 失败:`, e.message);
        return null;
      }
    };

    const gradeOpts = { task, prompt, essay, wordCount, images, signal: sse.signal };

    // 两个评分先并行跑（它们是最长的一环）
    const [passA, passB] = await Promise.all([
      runTask('pass1', () => gradePass({
        ...gradeOpts,
        pass: 'A',
        onPhase: (p) => sse.send('task', { id: 'pass1', status: 'retrying', note: p.type }),
      })),
      runTask('pass2', () => gradePass({
        ...gradeOpts,
        pass: 'B',
        onPhase: (p) => sse.send('task', { id: 'pass2', status: 'retrying', note: p.type }),
      })),
    ]);

    if (!passA || !passB) {
      // 失败也要留下原文和图片，但绝不写 submissions
      persistFailure({
        id,
        task,
        topic,
        prompt,
        essay,
        imageBase64,
        wordCount,
        model: llmConfig().model || null,
        reason: failures[0]?.message || '未知',
      });
      sse.send('error', {
        message: `评分失败，记录未写入看板。原因：${failures[0]?.message || '未知'}`,
        id,
      });
      sse.send('done', { id, status: 'FAILED' });
      return sse.close();
    }

    const merged = combineResults(passA.data, passB.data);

    // 改写放在评分之后：带上四维分和主要问题，目标明确
    const revision = await runTask('revision', async () => {
      const r = await chat({
        messages: buildReviseMessages({
          task,
          prompt,
          essay,
          overall: merged.score.overall,
          weaknesses: merged.weaknesses,
        }),
        temperature: 0.5,
        maxTokens: 4000,
        signal: sse.signal,
      });
      return { text: r.text.trim() };
    });

    // 落盘：契约文件 + 完整数据（三条路径共用 persistAssessment）
    const revisionText = revision?.text && revisionLooksSane(revision.text, essay) ? revision.text : null;
    if (revision?.text && !revisionText) {
      console.warn('[grade] 改写稿长度异常，已丢弃:', countWords(revision.text), '词 / 原文', countWords(essay), '词');
    }

    const result = persistAssessment({
      id,
      task,
      topic,
      prompt,
      essay,
      imageBase64,
      wordCount,
      durationMin: body.duration_min,
      merged,
      passes: { a: passA, b: passB },
      revision: revisionText,
      source: 'api',
      model: llmConfig().model || null,
    });

    sse.send('merged', { id, ...merged, wordCount });
    if (revisionText) sse.send('revision', { id, text: revisionText });
    else sse.send('revision', { id, text: '', error: '改写生成失败或长度异常，可在结果页重试' });
    sse.send('done', { id, status: 'COMPLETED', file: result.file });
  } catch (e) {
    if (!sse.signal.aborted) sse.send('error', { message: e.message });
    else sse.send('error', { message: '请求已取消' });
  } finally {
    sse.close();
    // 落盘了就撤占位；什么都没留下（取消 / 403）就放开这个 ID
    if (!store.settleClaim(id)) store.releaseClaim(id);
  }
});

// ---------------------------------------------------------------------------
// 重新生成改写
// ---------------------------------------------------------------------------
app.post('/api/assessments/:id/revise', async (req, res) => {
  const { id } = req.params;
  if (!isSafeId(id)) return badId(res);
  const data = store.getAssessment(id);
  if (!data) return res.status(404).json({ error: '没有这条记录' });

  if (getSettings().mode !== 'api') {
    return res.status(409).json({
      error: '重新生成改写要走模型直连，当前是文件队列模式。到右上角设置里切到「自己的 API」再用。',
    });
  }

  const sse = openSSE(req, res);
  try {
    const merged = data.merged?.score || null;
    const r = await chat({
      messages: buildReviseMessages({
        task: data.meta.task,
        prompt: data.meta.prompt,
        essay: data.original || '',
        overall: merged?.overall ?? null,
        weaknesses: data.merged?.weaknesses || [],
      }),
      temperature: 0.5,
      maxTokens: 4000,
      signal: sse.signal,
    });
    const text = r.text.trim();
    if (!revisionLooksSane(text, data.original || '')) {
      sse.send('error', {
        message: `改写稿长度异常（${countWords(text)} 词 / 原文 ${countWords(data.original)} 词），已丢弃。再点一次通常会好。`,
      });
      sse.send('done', { id, ok: false, text: '' });
      return sse.close();
    }
    store.saveText(id, 'revised.md', text);
    sse.send('revision', { id, text });
    sse.send('done', { id, ok: true });
  } catch (e) {
    const message = sse.signal.aborted ? '请求已取消' : e.message;
    sse.send('error', { message });
    sse.send('done', { id, ok: false });
  } finally {
    sse.close();
  }
});

// ---------------------------------------------------------------------------
// 追问对话（流式）
// ---------------------------------------------------------------------------
app.post('/api/assessments/:id/chat', async (req, res) => {
  const { id } = req.params;
  if (!isSafeId(id)) return badId(res);

  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: '问题不能为空' });

  const data = store.getAssessment(id);
  if (!data) return res.status(404).json({ error: '没有这条记录' });

  if (getSettings().mode !== 'api') {
    return res.status(409).json({
      error: '追问对话要走模型直连，当前是文件队列模式。到右上角设置里切到「自己的 API」再用。',
    });
  }

  const sse = openSSE(req, res);
  try {
    const history = store.readChat(id);
    const merged = data.merged?.score
      ? { ...data.merged.score, weaknesses: data.merged.weaknesses }
      : null;

    store.appendChat(id, { role: 'user', content: question, at: new Date().toISOString() });

    let answer = '';
    let failed = null;
    try {
      answer = await chatStream({
        messages: buildChatMessages({
          task: data.meta.task,
          prompt: data.meta.prompt,
          essay: data.original || '',
          merged,
          history,
          question,
        }),
        temperature: 0.4,
        maxTokens: 1600,
        signal: sse.signal,
        onDelta: (d) => sse.send('delta', { text: d }),
      });
    } catch (e) {
      failed = sse.signal.aborted ? '请求已取消' : e.message;
      sse.send('error', { message: failed });
    }

    if (answer) {
      store.appendChat(id, { role: 'assistant', content: answer, at: new Date().toISOString() });
    }
    sse.send('done', { id, ok: !failed, text: answer, ...(failed ? { message: failed } : {}) });
  } catch (e) {
    const message = sse.signal.aborted ? '请求已取消' : e.message;
    sse.send('error', { message });
    sse.send('done', { id, ok: false, message });
  } finally {
    sse.close();
  }
});

// ---------------------------------------------------------------------------
// 记录读写
// ---------------------------------------------------------------------------
app.get('/api/assessments', (_req, res) => {
  try {
    res.json({ items: store.listAssessments() });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/assessments/:id', (req, res) => {
  const { id } = req.params;
  if (!isSafeId(id)) return badId(res);
  const data = store.getAssessment(id);
  if (!data) return res.status(404).json({ error: '没有这条记录' });
  res.json(data);
});

app.delete('/api/assessments/:id', (req, res) => {
  const { id } = req.params;
  if (!isSafeId(id)) return badId(res);
  const meta = store.readMeta(id);
  if (!meta) return res.status(404).json({ error: '没有这条记录' });
  store.deleteAssessment(id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 生产模式：如果 build 过，直接托管 dist
// ---------------------------------------------------------------------------
const dist = path.join(__dirname, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ---------------------------------------------------------------------------
// 统一错误处理：CORS 拒绝、坏 JSON body、未捕获异常
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  if (err?.code === ORIGIN_REJECTED) {
    return res.status(403).json({ error: `来源不被允许：${err.origin || '未知'}` });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法 JSON' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体太大（图片请压缩到 16MB 以内）' });
  }
  console.error('[server] 未处理错误:', err);
  return res.status(500).json({ error: err?.message || '服务器错误' });
});

const server = app.listen(PORT, HOST, () => {
  const cfg = llmConfig();
  const missing = missingFields();
  console.log(`[server] http://${HOST}:${PORT}`);
  console.log(`[server] 数据目录 ${IELTS_HOME}`);
  console.log(`[server] 允许的来源 ${[...ORIGINS].join(', ')}`);
  if (missing.length) {
    console.warn(`[server] 还没配置 ${missing.join(' / ')}，打开界面后点右上角「设置」填写。`);
  } else {
    console.log(`[server] 模型 ${cfg.model}`);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[server] 端口 ${PORT} 被占用。换个端口：PORT=4101 npm start（vite.config.js 的 proxy 也要改）。`);
  } else {
    console.error('[server] 启动失败:', e);
  }
  process.exit(1);
});

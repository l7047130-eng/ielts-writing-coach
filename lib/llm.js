import { getSettings, missingFields } from './settings.js';

// ---------------------------------------------------------------------------
// OpenAI 兼容接口。配置来自界面（config.local.json），不读 .env。
// ---------------------------------------------------------------------------
export function llmConfig() {
  const s = getSettings();
  return { base: s.base, model: s.model, hasKey: Boolean(s.key) };
}

export function assertLLM() {
  const missing = missingFields();
  if (missing.length) {
    throw new Error(`还没配置 ${missing.join(' / ')}。点右上角「设置」填一下。`);
  }
}

// 图片挂到最后一条 user 消息上，转成 content 数组
function attachImages(messages, images) {
  if (!images || images.length === 0) return messages;
  const out = messages.map((m) => ({ ...m }));
  let idx = -1;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].role === 'user') { idx = i; break; }
  }
  if (idx < 0) return messages;
  const text = typeof out[idx].content === 'string' ? out[idx].content : '';
  out[idx] = {
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ],
  };
  return out;
}

function pickContent(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  return '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 统一出口。返回 { text, finishReason, usage, ms }
 * 429 / 5xx / 网络错误退避重试 2 次。
 */
export async function chat({
  messages,
  json = false,
  images = [],
  temperature = 0,
  maxTokens = 4000,
  signal,
  onRetry,
} = {}) {
  assertLLM();
  const s = getSettings();

  const body = {
    model: s.model,
    messages: attachImages(messages, images),
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (json) body.response_format = { type: 'json_object' };

  const url = `${s.base}/chat/completions`;
  let lastErr;

  for (let attempt = 0; attempt <= 2; attempt += 1) {
    if (signal?.aborted) throw new Error('已取消');
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${s.key}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (res.status === 429 || res.status >= 500) {
        const detail = await res.text().catch(() => '');
        lastErr = new Error(`模型接口 ${res.status}：${detail.slice(0, 300)}`);
        if (attempt < 2) {
          onRetry?.({ attempt: attempt + 1, status: res.status });
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw lastErr;
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`模型接口 ${res.status}：${detail.slice(0, 500)}`);
      }

      const data = await res.json();
      const choice = data?.choices?.[0];
      const text = pickContent(choice?.message);
      const finishReason = choice?.finish_reason || null;

      // 推理模型会把 max_tokens 全耗在 thinking 上，正文一个字都没有。
      // 这种情况加预算重试，而不是把空字符串交给上层。
      if (!text.trim() && finishReason === 'length' && body.max_tokens < 16000) {
        body.max_tokens = Math.min(16000, Math.round(body.max_tokens * 1.8));
        if (attempt < 2) {
          onRetry?.({ attempt: attempt + 1, status: 'empty-content' });
          // 不 sleep：这不是限流，是预算不够
          continue;
        }
      }

      return {
        text,
        finishReason,
        usage: data?.usage || null,
        ms: Date.now() - started,
      };
    } catch (e) {
      if (signal?.aborted) throw new Error('已取消');
      lastErr = e;
      const retryable = e?.name === 'TypeError' || /ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(e?.message));
      if (retryable && attempt < 2) {
        onRetry?.({ attempt: attempt + 1, status: 'network' });
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('模型调用失败');
}

/**
 * 流式版本，用于对话面板。onDelta 收到增量文本。
 */
export async function chatStream({
  messages,
  temperature = 0.4,
  maxTokens = 1600,
  signal,
  onDelta,
} = {}) {
  assertLLM();
  const s = getSettings();

  const res = await fetch(`${s.base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.key}`,
    },
    body: JSON.stringify({
      model: s.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    }),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`模型接口 ${res.status}：${detail.slice(0, 400)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') return full;
      try {
        const j = JSON.parse(payload);
        const delta = j?.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          onDelta?.(delta);
        }
      } catch {
        // 上游偶尔发心跳/注释行，忽略
      }
    }
  }
  return full;
}

// 1x1 红色 PNG，用来测视觉通路
export const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 从 OpenAI 兼容响应里取正文；结构不对返回 null，别把空当成成功 */
function readChoiceText(payload) {
  let data;
  try {
    data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    return null;
  }
  const choice = data?.choices?.[0];
  if (!choice) return null;
  return pickContent(choice.message);
}

/**
 * 用给定（或已保存）配置做一次连通性 + 能力探测。界面上的「测试」按钮调它。
 *
 * 关键：把「请求成功」和「能力验证成功」分开。
 * - textRequest / visionRequest：HTTP 通了、响应结构对（说明接口和 key 没问题）
 * - text / vision：真的拿到了有效文本 / 真的读出了图里的内容
 * 以前只看 HTTP 状态，接口回空正文也会被标成 text=true、vision=true。
 */
export async function testConnection({ base, key, model } = {}) {
  const saved = getSettings();
  const cfg = {
    base: String(base || saved.base || '').trim().replace(/\/+$/, ''),
    key: String(key || saved.key || '').trim(),
    model: String(model || saved.model || '').trim(),
  };

  const out = {
    model: cfg.model,
    error: null,
    // 请求层：连通 + 响应结构正确
    textRequest: false,
    visionRequest: false,
    // 能力层：拿到了可核对的内容
    text: false,
    vision: false,
    textSample: '',
    visionSample: '',
  };
  if (!cfg.base || !cfg.key || !cfg.model) {
    out.error = '接口地址 / API Key / 模型名 三项都要填';
    return out;
  }

  const call = async (content) => {
    const r = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content }],
        max_tokens: 64,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text)?.error?.message || msg; } catch { /* ignore */ }
      throw new Error(`${r.status} ${msg}`);
    }
    return readChoiceText(text);
  };

  // 1) 文本通路
  try {
    const body = await call('只回两个字符：OK');
    out.textRequest = true;                 // 结构和 HTTP 都过了
    const sample = String(body || '').trim();
    out.textSample = sample.slice(0, 40);
    if (sample) out.text = true;
    else out.error = '接口返回 200，但正文是空的（可能是推理模型把 token 全花在 thinking 上，或该模型不支持纯文本对话）';
  } catch (e) {
    out.error = `文本通路失败：${e.message}`;
    return out;
  }

  // 2) 视觉通路：1x1 纯红 PNG。能读到图就必须能说出 red / 红，
  //    只有「接口收下了图片」不算验证通过。
  try {
    const body = await call([
      { type: 'text', text: '这张图是什么颜色？只回一个词。' },
      { type: 'image_url', image_url: { url: TINY_PNG } },
    ]);
    out.visionRequest = true;
    const sample = String(body || '').trim();
    out.visionSample = sample.slice(0, 40);
    if (/red|红/i.test(sample)) {
      out.vision = true;
    } else if (!out.error) {
      out.error = sample
        ? `接口接受了图片，但回答「${sample.slice(0, 40)}」不是可核对的颜色（预期 red）。图片理解能力未验证通过。`
        : '接口接受了图片但正文为空，图片理解能力未验证通过。';
    }
  } catch (e) {
    if (!out.error) out.error = `视觉通路失败：${e.message}`;
  }

  return out;
}

/** 拉模型列表，界面上的下拉用 */
export async function listModels({ base, key } = {}) {
  const saved = getSettings();
  const b = String(base || saved.base || '').trim().replace(/\/+$/, '');
  const k = String(key || saved.key || '').trim();
  if (!b || !k) throw new Error('先填接口地址和 API Key');

  const r = await fetch(`${b}/models`, {
    headers: { Authorization: `Bearer ${k}` },
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text)?.error?.message || msg; } catch { /* ignore */ }
    throw new Error(`${r.status} ${msg}`);
  }
  const j = JSON.parse(text);
  const ids = (j.data || j.models || [])
    .map((m) => m.id || m.name)
    .filter(Boolean);
  return ids;
}

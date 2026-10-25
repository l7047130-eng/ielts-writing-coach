const BASE = '/api';

function httpError(path, status, message, warnings) {
  const err = new Error(message || `${path}: ${status}`);
  err.status = status;
  err.warnings = Array.isArray(warnings) ? warnings : [];
  return err;
}

export async function fetchJSON(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) {
    let msg = `${path}: ${r.status}`;
    try {
      const j = await r.json();
      if (j?.error) msg = j.error;
    } catch { /* ignore */ }
    throw httpError(path, r.status, msg);
  }
  return r.json();
}

export async function sendJSON(path, method, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = `${path}: ${r.status}`;
    let warnings = [];
    try {
      const j = await r.json();
      if (j?.error) msg = j.error;
      if (Array.isArray(j?.warnings)) warnings = j.warnings;
    } catch { /* ignore */ }
    throw httpError(path, r.status, msg, warnings);
  }
  return r.json();
}

/**
 * POST + 解析 SSE。EventSource 发不了 POST，所以手动读流。
 * onEvent(eventName, data)
 */
export async function streamPost(path, body, onEvent, signal) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch { /* ignore */ }
    throw httpError(path, res.status, msg);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;

    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      let event = 'message';
      const dataLines = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;

      let data;
      const joined = dataLines.join('\n');
      try { data = JSON.parse(joined); } catch { data = joined; }
      onEvent(event, data);
    }
  }
}

/**
 * SSE 语义封装：区分三类失败
 *   http    HTTP 非 2xx（key、模型名、接口地址之类）
 *   sse     服务端明确发来 event:error（模型返回 400 等业务错误）
 *   broken  连接断了但没有 done（代理超时、进程被杀）
 * 以前只处理 delta，error 事件被吞掉，页面只剩用户的问题。
 */
export async function streamRequest(path, body, onEvent, signal) {
  let failure = null;
  let sawDone = false;

  await streamPost(path, body, (event, data) => {
    if (event === 'error') {
      failure = (data && data.message) || '模型接口返回错误';
    }
    if (event === 'done') sawDone = true;
    onEvent?.(event, data);
  }, signal);

  if (failure) {
    const err = new Error(failure);
    err.kind = 'sse';
    throw err;
  }
  if (!sawDone) {
    const err = new Error('连接中断：没有收到结束信号，这一轮结果不完整，可以重试');
    err.kind = 'broken';
    throw err;
  }
}

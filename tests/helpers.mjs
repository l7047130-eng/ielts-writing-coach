import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 每个测试用独立的临时 IELTS_HOME，绝不碰 ~/.ielts */
export function tmpHome(label = 'home') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-${label}-`));
  return dir;
}

export function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

export function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

/** 把文件 mtime 往前拨，跳过「刚写入」的宽容窗口 */
export function ageFile(file, seconds) {
  const t = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(file, t, t);
}

export const queueDirs = (home) => {
  const root = path.join(home, 'writing', 'queue');
  return {
    root,
    pending: path.join(root, 'pending'),
    done: path.join(root, 'done'),
    failed: path.join(root, 'failed'),
    attachments: path.join(root, 'attachments'),
    claims: path.join(root, 'claims'),
    imported: path.join(root, 'imported'),
  };
};

/** 写一份合法的完整批改结果 */
export function fullGrade(overrides = {}) {
  const quote = 'Public libraries provide access to useful information';
  return {
    tr: 6.5,
    cc: 6,
    lr: 6.5,
    ga: 6,
    dims: {
      tr: { comment: '任务回应基本完整，但第二个子问题只写了一句就收尾，所以停在 6.5 而不是 7。', evidence: [quote], fix_example: '补一句让步再收束。' },
      cc: { comment: '分段清楚，连接词略机械，因此停在 6 而不是 6.5。', evidence: [quote], fix_example: '把 Moreover 换成具体指代。' },
      lr: { comment: '词汇够用，偶有搭配不准，够 6.5 不到 7。', evidence: [quote], fix_example: 'provide access to → open up access to' },
      ga: { comment: '简单句与复杂句混用，错误很少影响理解，停在 6。', evidence: [quote], fix_example: '合并两个短句。' },
    },
    errors: [{ type: 'grammar', tag: 'article_misuse', count: 2, examples: ['a useful → useful'] }],
    strengths: ['立场清楚'],
    weaknesses: ['论证展开不足'],
    next_actions: ['每个主体段补一个例子'],
    ...overrides,
  };
}

/** 启动一个 OpenAI 兼容的假模型；script 是按序返回的响应 */
export function startMockModel(script = []) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      calls.push({ url: req.url, body: parsed });

      const next = typeof script === 'function'
        ? script(calls.length, parsed)
        : script[Math.min(calls.length - 1, script.length - 1)];

      if (next && next.status && next.status !== 200) {
        res.writeHead(next.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: next.message || 'mock error' } }));
        return;
      }
      const content = next?.content ?? 'OK';
      const payload = {
        choices: [{ message: { role: 'assistant', content }, finish_reason: next?.finish || 'stop' }],
        usage: { total_tokens: 10 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        calls,
        base: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** 起一个独立的 server.js 进程，环境完全隔离 */
export async function startServer({ home, config, extraEnv = {} }) {
  const port = 4300 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      IELTS_HOME: home,
      WRITING_COACH_CONFIG: config,
      PORT: String(port),
      HOST: '127.0.0.1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  const base = `http://127.0.0.1:${port}`;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server 启动超时\n${logs.join('')}`)), 15000);
    const onData = (d) => {
      const s = d.toString();
      logs.push(s);
      if (s.includes('[server] http://')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => logs.push(d.toString()));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server 提前退出 code=${code}\n${logs.join('')}`));
    });
  });

  return {
    base,
    logs,
    stop: () => new Promise((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
    }),
    api: async (p, opt = {}) => {
      const r = await fetch(base + p, {
        headers: { 'Content-Type': 'application/json' },
        ...opt,
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: r.status, body, headers: r.headers };
    },
  };
}

export async function waitFor(fn, { timeout = 5000, interval = 50 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * 原生 TCP 请求。Host 头要真的按字节发出去，
 * 不能指望 fetch —— 有些客户端实现会忽略/改写 Host。
 */
export function rawRequest(port, raw) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    sock.setTimeout(10000);
    sock.on('connect', () => sock.write(raw));
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('原生请求超时')); });
    sock.on('error', reject);
    sock.on('close', () => {
      const [head, ...rest] = buf.split('\r\n\r\n');
      const [statusLine, ...headers] = (head || '').split('\r\n');
      const status = Number(/^HTTP\/\d\.\d (\d+)/.exec(statusLine || '')?.[1] || 0);
      const map = {};
      for (const h of headers) {
        const i = h.indexOf(':');
        if (i > 0) map[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
      }
      resolve({ status, headers: map, body: rest.join('\r\n\r\n') });
    });
  });
}

export const rawGet = (port, reqPath, headers = {}) => {
  const lines = [`GET ${reqPath} HTTP/1.1`, 'Connection: close'];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  lines.push('', '');
  return rawRequest(port, lines.join('\r\n'));
};

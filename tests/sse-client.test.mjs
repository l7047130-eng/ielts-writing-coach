import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ---------------------------------------------------------------------------
// 前端 SSE 封装：把「HTTP 错误 / 业务 error 事件 / 连接中断」分清
// 这里用本地假服务，不碰真实模型
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/ok')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: delta\ndata: {"text":"你"}\n\n');
    res.write('event: delta\ndata: {"text":"好"}\n\n');
    res.write('event: done\ndata: {"ok":true}\n\n');
    res.end();
    return;
  }
  if (req.url.startsWith('/api/business-error')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: error\ndata: {"message":"模型接口 400：bad request"}\n\n');
    res.write('event: done\ndata: {"ok":false}\n\n');
    res.end();
    return;
  }
  if (req.url.startsWith('/api/broken')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: delta\ndata: {"text":"半句"}\n\n');
    res.end();     // 没有 done，模拟代理超时
    return;
  }
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: '内部错误' }));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const BASE = `http://127.0.0.1:${port}`;

const realFetch = globalThis.fetch;
globalThis.fetch = (url, opt) => {
  const u = String(url);
  return realFetch(u.startsWith('/api') ? BASE + u : u, opt);
};

const { streamRequest } = await import('../src/api.js');

test.after(() => new Promise((r) => server.close(r)));

test('正常流：delta 拼接后收到 done', async () => {
  let text = '';
  await streamRequest('/ok', {}, (ev, data) => {
    if (ev === 'delta') text += data.text;
  });
  assert.equal(text, '你好');
});

test('业务 error 事件不再被吞：抛错并带上服务端原因', async () => {
  let deltas = 0;
  await assert.rejects(
    () => streamRequest('/business-error', {}, (ev) => { if (ev === 'delta') deltas += 1; }),
    (e) => {
      assert.equal(e.kind, 'sse');
      assert.match(e.message, /模型接口 400/);
      return true;
    },
  );
  assert.equal(deltas, 0);
});

test('连接中断（没有 done）也能识别出来', async () => {
  let text = '';
  await assert.rejects(
    () => streamRequest('/broken', {}, (ev, data) => { if (ev === 'delta') text += data.text; }),
    (e) => {
      assert.equal(e.kind, 'broken');
      assert.match(e.message, /连接中断/);
      return true;
    },
  );
  assert.equal(text, '半句', '半截内容也要留给调用方');
});

test('HTTP 非 2xx 抛带 status 的错误', async () => {
  await assert.rejects(
    () => streamRequest('/http-fail', {}, () => {}),
    (e) => {
      assert.equal(e.status, 500);
      assert.match(e.message, /内部错误/);
      return true;
    },
  );
});

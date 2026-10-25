import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-safe-'));
process.env.IELTS_HOME = HOME;
process.env.WRITING_COACH_CONFIG = path.join(HOME, 'config.json');

const { isSafeId, assertSafeId } = await import('../lib/ids.js');
const { assessmentDir, resolveInside, assertInside, PATHS, QPATHS } = await import('../lib/paths.js');
const { isAllowedOrigin, allowedOrigins } = await import('../lib/security.js');

// ---------------------------------------------------------------------------
// ID 边界
// ---------------------------------------------------------------------------
test('路径分隔符、绝对路径、上级目录一律拒绝', () => {
  const bad = [
    '..', '.', '../x', '..\\x', 'a/b', 'a\\b', 'C:\\Windows\\x', '/etc/passwd',
    'a..b', 'x.', '', null, undefined, 123, {}, 'a b', 'a\u0000b', 'a\nb',
  ];
  for (const v of bad) {
    assert.equal(isSafeId(v), false, `${JSON.stringify(v)} 应该被判为不安全`);
    assert.throws(() => assertSafeId(v), /不合法/, `${JSON.stringify(v)} 应该抛错`);
  }
});

test('正常的记录 id 仍然可用', () => {
  const ok = [
    '20261024_task2_ageing-population',
    '20261024_task2_ageing-population-2',
    'review-20261024_task2_x',
    'A1', 'a_b.c-d',
    // 中文与中英混合：slugify 本来就保留中文，校验规则必须跟上
    '20261023_task2_公共图书馆',
    '20261024_task2_雅思-task2-写作',
    'review-20261023_task2_公共图书馆-2',
  ];
  for (const v of ok) assert.equal(isSafeId(v), true, `${v} 应该合法`);
});

test('危险文件名仍然被拒（含中文场景）', () => {
  const bad = [
    '公共图书馆..\\..\\evil',
    '公共/图书馆',
    '公共\\图书馆',
    'CON', 'con.txt', 'aux', 'NUL', 'com1', 'lpt9.txt',
    '公共图书馆.', '  公共图书馆',
  ];
  for (const v of bad) {
    assert.equal(isSafeId(v), false, `${JSON.stringify(v)} 应该被判为不安全`);
    assert.throws(() => assertSafeId(v), /不合法/);
  }
});

test('assessmentDir 对越界 id 抛错，而不是拼出目录外的路径', () => {
  assert.throws(() => assessmentDir('..\\..\\evil'), /不合法|越界/);
  assert.throws(() => assessmentDir('../../evil'), /不合法|越界/);
});

// ---------------------------------------------------------------------------
// 路径归属
// ---------------------------------------------------------------------------
test('resolveInside 把越界目标挡住', () => {
  const root = path.join(HOME, 'writing', 'assessments');
  assert.equal(resolveInside(root, 'ok-id'), path.join(root, 'ok-id'));
  assert.throws(() => resolveInside(root, '..', 'escaped'), /越界/);
  assert.throws(() => resolveInside(root, '..\\escaped'), /越界/);
  assert.throws(() => resolveInside(root, path.join(HOME, 'elsewhere')), /越界/);
});

test('assertInside 对绝对路径同样生效', () => {
  const root = path.join(HOME, 'writing', 'submissions');
  assert.equal(assertInside(root, path.join(root, 'a.md')), path.join(root, 'a.md'));
  assert.throws(() => assertInside(root, path.join(HOME, 'a.md')), /越界/);
});

test('哨兵文件不会被越界写入（只在临时目录里做）', () => {
  const sentinel = path.join(HOME, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'untouched');
  const root = path.join(HOME, 'writing', 'queue', 'claims');
  fs.mkdirSync(root, { recursive: true });

  // 想要写到 claims 之外，只能靠 ..；两条路径都必须被拒
  for (const evil of ['..\\sentinel.txt', '../sentinel.txt']) {
    assert.throws(() => resolveInside(root, evil), /越界/);
  }
  // URL 编码的形态在服务端入口就被解码成 ..\，这里再拦一次
  assert.throws(() => resolveInside(root, decodeURIComponent('..%5Csentinel.txt')), /越界/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
});

test('QPATHS 都在 IELTS_HOME 之内', () => {
  for (const [k, v] of Object.entries(QPATHS)) {
    assert.ok(v.startsWith(HOME), `${k} 跑到了数据目录外面：${v}`);
  }
  assert.ok(PATHS.writing.submissions.startsWith(HOME));
});

// ---------------------------------------------------------------------------
// CORS 来源
// ---------------------------------------------------------------------------
test('伪装成 localhost 的域名不会被放行', () => {
  const set = allowedOrigins({});
  const bad = [
    'https://localhost.attacker.example',
    'http://127.0.0.1.nip.io',
    'http://localhost.evil.com',
    'http://localhost:6000',
    'null',
    'file://',
  ];
  for (const o of bad) {
    assert.equal(isAllowedOrigin(o, set), false, `${o} 不该被允许`);
  }
});

test('本地开发端口默认放行，没有 Origin 头也放行', () => {
  const set = allowedOrigins({});
  for (const o of ['http://localhost:5273', 'http://127.0.0.1:5273', 'http://localhost:4100', 'http://127.0.0.1:5173']) {
    assert.equal(isAllowedOrigin(o, set), true, `${o} 应该被允许`);
  }
  assert.equal(isAllowedOrigin(undefined, set), true);
  assert.equal(isAllowedOrigin('', set), true);
});

test('ALLOWED_ORIGINS 可以补精确来源', () => {
  const set = allowedOrigins({ ALLOWED_ORIGINS: 'http://192.168.1.9:4100, http://foo.local:80' });
  assert.equal(isAllowedOrigin('http://192.168.1.9:4100', set), true);
  assert.equal(isAllowedOrigin('http://foo.local:80', set), true);
  assert.equal(isAllowedOrigin('http://192.168.1.9:4101', set), false);
});

test('同源放行只对受信任 Host 成立（换 PORT 正常，伪造 Host 被拒）', async () => {
  const { originDecision, isTrustedHost, allowedHosts } = await import('../lib/security.js');
  const set = allowedOrigins({});
  const hosts = allowedHosts({});

  // 本地页面换 PORT：Host 可信 → 同源放行
  assert.equal(isTrustedHost('127.0.0.1:4509', hosts), true);
  assert.equal(originDecision({
    origin: 'http://127.0.0.1:4509',
    selfOrigin: 'http://127.0.0.1:4509',
    hostAllowed: true,
    set,
  }).allowed, true);

  // 攻击者把 Host 和 Origin 都伪造成自己：同源不成立
  assert.equal(isTrustedHost('attacker.example', hosts), false);
  const evil = originDecision({
    origin: 'http://attacker.example',
    selfOrigin: 'http://attacker.example',
    hostAllowed: false,
    set,
  });
  assert.equal(evil.allowed, false);
  assert.equal(evil.reason, 'untrusted-host');

  // 局域网部署地址要显式配置
  const lan = allowedHosts({ ALLOWED_HOSTS: '192.168.1.9, intranet.local' });
  assert.equal(isTrustedHost('192.168.1.9:4100', lan), true);
  assert.equal(isTrustedHost('intranet.local:4100', lan), true);
  assert.equal(isTrustedHost('192.168.1.10:4100', lan), false);
});

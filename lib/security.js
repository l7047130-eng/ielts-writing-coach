// ---------------------------------------------------------------------------
// 来源白名单
// 之前 CORS 用 /localhost|127\.0\.0\.1/ 做正则匹配，
// `https://localhost.attacker.example` 也能命中，等于对任意域名开放读取。
// 改成精确白名单后又踩过一次：同源放行直接拿请求的 Host 拼 selfOrigin，
// 客户端只要把 Host 和 Origin 都设成 attacker.example 就能自证可信。
// 现在：先确认 Host 属于配置允许的服务地址，同源放行才成立。
// ---------------------------------------------------------------------------

export const ORIGIN_REJECTED = 'EORIGIN';

// 本地开发 / 单进程部署默认会用到的那几个
export const DEFAULT_ORIGINS = [
  'http://localhost:5273',
  'http://127.0.0.1:5273',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4100',
  'http://127.0.0.1:4100',
];

// 允许出现在 Host 头里的主机名。端口不参与判定：PORT 可换，主机身份才是信任依据。
export const DEFAULT_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

/** 额外来源用 ALLOWED_ORIGINS 环境变量补，逗号分隔，必须写完整 origin */
export function allowedOrigins(env = process.env) {
  const extra = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

/** 其它部署地址（局域网 IP、内网域名）用 ALLOWED_HOSTS 显式配置 */
export function allowedHosts(env = process.env) {
  const extra = String(env.ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_HOSTS.map((h) => h.toLowerCase()), ...extra]);
}

/** Host 头 → 主机名（去掉端口；IPv6 保留方括号写法） */
export function hostNameOf(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(0, end + 1) : raw;
  }
  return raw.split(':')[0];
}

/** Host 头是否属于配置允许的服务地址 */
export function isTrustedHost(hostHeader, set = allowedHosts()) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return false;
  const name = hostNameOf(raw);
  if (name && set.has(name)) return true;
  // 也接受配置里直接写 host:port 的完整形式
  return set.has(raw);
}

/**
 * 没有 Origin 头（curl、同源导航、服务端调用）放行；
 * 有 Origin 就必须在名单里，逐字符相等。
 */
export function isAllowedOrigin(origin, set = allowedOrigins()) {
  if (origin == null || origin === '') return true;
  if (origin === 'null') return false;
  return set.has(String(origin));
}

/**
 * 完整判定。
 * selfOrigin = 本次请求自己的 scheme://host。
 * 「同源放行」只在 host 可信时成立：否则攻击者改 Host 头就能自证，
 * 等于白名单形同虚设。换 PORT 后页面自己的 module 脚本也走这条分支。
 */
export function originDecision({
  origin,
  selfOrigin,
  hostAllowed = false,
  set = allowedOrigins(),
}) {
  if (origin == null || origin === '') return { allowed: true, reason: 'no-origin' };
  if (origin === 'null') return { allowed: false, reason: 'null-origin' };
  if (set.has(origin)) return { allowed: true, reason: 'whitelisted' };
  const same = Boolean(selfOrigin) && origin === selfOrigin;
  if (same && hostAllowed) return { allowed: true, reason: 'same-origin' };
  if (same) return { allowed: false, reason: 'untrusted-host' };
  return { allowed: false, reason: 'not-allowed' };
}

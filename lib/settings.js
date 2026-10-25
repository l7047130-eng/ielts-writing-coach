import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 测试可以指到临时文件，绝不碰用户真实的 config.local.json
const CONFIG_FILE = process.env.WRITING_COACH_CONFIG || path.join(__dirname, '..', 'config.local.json');

// queue：文件队列（默认，不花 token）；api：自己填 key 直连
export const MODES = ['queue', 'api'];
const DEFAULT_MODE = 'queue';

let cache = null;

function normalizeBase(v) {
  return String(v || '').trim().replace(/\/+$/, '');
}

export function getSettings() {
  if (cache) return cache;
  let file = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    file = {};
  }
  cache = {
    mode: MODES.includes(file.mode) ? file.mode : DEFAULT_MODE,
    base: normalizeBase(file.base),
    key: String(file.key || '').trim(),
    model: String(file.model || '').trim(),
  };
  return cache;
}

/**
 * 只写界面提交的内容。
 * key 语义：undefined / 空字符串 = 保留原来的；null = 显式清除。
 */
export function saveSettings({ mode, base, key, model }) {
  const prev = getSettings();
  const next = {
    mode: MODES.includes(mode) ? mode : prev.mode,
    base: base === undefined ? prev.base : normalizeBase(base),
    key: key === null ? '' : (key ? String(key).trim() : prev.key),
    model: model === undefined ? prev.model : String(model || '').trim(),
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  cache = next;
  return next;
}

export function publicSettings() {
  const s = getSettings();
  return {
    mode: s.mode,
    base: s.base,
    model: s.model,
    hasKey: Boolean(s.key),
    keyPreview: s.key ? `${s.key.slice(0, 6)}***${s.key.slice(-4)}` : '',
  };
}

// 只有 api 模式才要求填接口凭据；队列和粘贴模式完全不碰模型接口
export function missingFields() {
  const s = getSettings();
  if (s.mode !== 'api') return [];
  const m = [];
  if (!s.base) m.push('接口地址');
  if (!s.key) m.push('API Key');
  if (!s.model) m.push('模型名');
  return m;
}

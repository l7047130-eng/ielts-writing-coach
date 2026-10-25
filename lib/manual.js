import { DIM_KEYS } from './contract.js';
import { validateGrade, validateReview } from './grading.js';

// ---------------------------------------------------------------------------
// 解析 AI 写回的结果。手动路径没有 repairJSON 兜底，容错要靠这里做足。
// 但容错只处理「包装差异」，不猜分数：
//   kind='full'   完整批改契约（四维分数 + 四维点评）
//   kind='review' 仅分数复核契约（只认四个合法 band）
// 之前不区分 kind，复核的四分数对象会被当成 passA，随后又报「没有 passB」。
// ---------------------------------------------------------------------------

const normWs = (s) => String(s ?? '')
  .replace(/[\u201c\u201d]/g, '"')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const ENVELOPE_GRADE = ['passA', 'pass_a', 'grade', 'result', 'full'];
const ENVELOPE_REVIEW = ['passB', 'pass_b', 'review'];
const ENVELOPE_REVISION = ['revision', 'revised', 'rewrite', 'rewritten', 'revision_text'];

/** 括号平衡扫描：取所有顶层 {...}，能容忍字符串里的花括号和围栏 */
export function scanObjects(text) {
  const src = String(text ?? '');
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      if (depth) inStr = true;
      continue;
    }
    if (c === '{') {
      if (!depth) start = i;
      depth += 1;
    } else if (c === '}') {
      if (depth) {
        depth -= 1;
        if (depth === 0) {
          out.push(src.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

/** JSON.parse 的宽松版：中文引号、尾逗号、行注释 */
export function looseParse(src) {
  const s = String(src ?? '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/^\s*\/\/.*$/gm, '');
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function firstKey(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return null;
}

function scoreKeysPresent(o) {
  if (!o || typeof o !== 'object') return 0;
  const src = o.scores && typeof o.scores === 'object' ? { ...o.scores, ...o } : o;
  return DIM_KEYS.filter((k) => {
    const alts = [k, k.toUpperCase(), `${k}_score`];
    return alts.some((a) => src[a] != null);
  }).length;
}

const richness = (o) => ((o?.dims ? 2 : 0) + (o?.errors ? 1 : 0) + (o?.strengths ? 1 : 0));

/** 从散文里定位「改写后的正文」 */
export function extractRevision(text) {
  const lines = String(text ?? '').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i].trim();
    if (!l) continue;
    const isHead = /^(#{1,4}\s*)?(【)?\s*(改写后的正文|改写稿|改写|重写|revised?\s*(version|essay)|rewritten?(\s*version)?)\s*(】)?\s*[:：]?\s*$/i.test(l);
    if (isHead && l.length < 40) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;

  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (out.length && /^(#{1,4}\s+\S|【[^】]{1,24}】\s*$)/.test(t)) break;
    out.push(lines[i]);
  }
  const body = out.join('\n').trim();
  return body || null;
}

function cleanRevision(raw) {
  let t = String(raw ?? '').trim();
  t = t.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  t = t.replace(/^【?改写(后的正文|稿)?】?\s*[:：]?\s*\n?/, '').trim();
  t = t.replace(/\n?[（(]\s*字数\s*[:：]?\s*\d+\s*(词|字)?\s*[)）]\s*$/, '').trim();
  return t || null;
}

/** 改写稿的基本体检，不合格就丢弃而不是写进磁盘 */
function vetRevision(raw, essay, warnings) {
  const t = cleanRevision(raw);
  if (!t) return null;
  if (normWs(t) === normWs(essay)) {
    warnings.push('改写稿与原文完全相同，已忽略');
    return null;
  }
  const ew = String(essay).split(/\s+/).filter(Boolean).length;
  const rw = t.split(/\s+/).filter(Boolean).length;
  if (ew > 30 && (rw < ew * 0.6 || rw > ew * 1.6)) {
    warnings.push(`改写稿 ${rw} 词，与原文 ${ew} 词相差过大，已忽略`);
    return null;
  }
  if (t.startsWith('{') && looseParse(t)) {
    warnings.push('改写稿是一段 JSON 而不是正文，已忽略');
    return null;
  }
  return t;
}

/**
 * 防粘错：evidence 是否真出自当前作文。
 * 太短的引用（<12 字符）不计分，避免模型把标点改一下就误判。
 */
export function verifyEvidence(passA, essay) {
  const essayNorm = normWs(essay);
  let total = 0;
  let hits = 0;
  for (const dim of Object.values(passA?.dims || {})) {
    for (const ev of dim?.evidence || []) {
      const e = normWs(ev);
      if (e.length < 12) continue;
      total += 1;
      if (essayNorm.includes(e)) hits += 1;
    }
  }
  return { total, hits, suspicious: total >= 2 && hits === 0 };
}

function collectObjects(raw, text, warnings) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return [raw];
  if (!text) return [];
  const objs = [];
  for (const chunk of scanObjects(text)) {
    const o = looseParse(chunk);
    if (o && typeof o === 'object' && !Array.isArray(o)) objs.push(o);
  }
  return objs;
}

/** 只有四个分数、没有任何点评的对象 —— 复核结果长这样 */
function isScoresOnly(o) {
  return Boolean(o) && typeof o === 'object' && scoreKeysPresent(o) === 4 && richness(o) === 0;
}

/**
 * 主入口。raw 可以是对象（done 文件的 JSON）或字符串（粘贴的回复）。
 * @param {object} opts
 * @param {string} opts.essay  当前作文原文（引用校验用）
 * @param {'full'|'review'} opts.kind  任务类型，决定用哪套契约
 */
export function parseQueueResult(raw, { essay = '', kind = 'full' } = {}) {
  const warnings = [];
  const text = typeof raw === 'string' ? raw : '';
  const objs = collectObjects(raw, text, warnings);

  if (objs.length === 0) {
    return {
      kind,
      passA: null,
      passB: null,
      revision: null,
      warnings: ['回复里没有找到任何 JSON 对象'],
      missing: kind === 'review' ? ['passB'] : ['passA'],
    };
  }

  if (kind === 'review') return parseReview(objs, { warnings });

  // ---------------- 完整批改 ----------------
  let passAObj = null;
  let passBObj = null;
  let revisionRaw = null;
  for (const o of objs) {
    const g = firstKey(o, ENVELOPE_GRADE);
    const r = firstKey(o, ENVELOPE_REVIEW);
    const rev = firstKey(o, ENVELOPE_REVISION);
    if (g && typeof g === 'object' && !passAObj) passAObj = g;
    if (r && typeof r === 'object' && !passBObj) passBObj = r;
    if (rev != null && revisionRaw == null) revisionRaw = rev;
  }

  // 没有信封就按形状挑：先挑「有真点评且分数合法」的，点评越全越优先
  if (!passAObj) {
    const ordered = [...objs].sort((x, y) => richness(y) - richness(x));
    for (const o of ordered) {
      if (validateGrade(o).ok) { passAObj = o; break; }
    }
    if (!passAObj) {
      // 退一步：有四个分数的也拿进来，让 validateGrade 给出「缺点评」这类具体原因，
      // 而不是一句含糊的「没有找到可用的评分对象」
      const rich = ordered.find((o) => richness(o) > 0)
        || ordered.find((o) => scoreKeysPresent(o) === 4);
      if (rich) passAObj = rich;
    }
  }

  let passA = null;
  if (passAObj) {
    const v = validateGrade(passAObj);
    if (v.ok) passA = v.data;
    else warnings.push(`评分主体校验未通过：${v.issues}`);
  } else {
    warnings.push('没有找到可用的评分对象');
  }

  // passB：只含四个分数、没有点评的那个对象
  if (!passBObj) {
    passBObj = objs.find((o) => o !== passAObj && isScoresOnly(o)) || null;
  }
  let passB = null;
  if (passBObj) {
    const v = validateReview(passBObj);
    if (v.ok) passB = v.data;
    else warnings.push(`复核分数校验未通过：${v.issues}`);
  }

  // 改写稿
  let revision = null;
  if (revisionRaw != null) {
    if (typeof revisionRaw === 'string') revision = vetRevision(revisionRaw, essay, warnings);
    else if (Array.isArray(revisionRaw)) revision = vetRevision(revisionRaw.join('\n\n'), essay, warnings);
    else if (typeof revisionRaw === 'object') {
      const t = firstKey(revisionRaw, ['text', 'content', 'essay', 'body', 'rewritten']);
      if (typeof t === 'string') revision = vetRevision(t, essay, warnings);
    }
  }
  if (!revision && text) revision = vetRevision(extractRevision(text), essay, warnings);

  // 粘错保护
  if (passA) {
    const ev = verifyEvidence(passA, essay);
    if (ev.suspicious) {
      return {
        kind,
        passA: null,
        passB: null,
        revision: null,
        warnings: [...warnings, `引用的原句在这篇作文里一条都找不到（${ev.total} 条全部未命中），这份回复可能不是对当前作文的`],
        missing: ['passA'],
        evidence: ev,
      };
    }
    if (ev.total > 0 && ev.hits === 0) warnings.push('部分证据句与环境不匹配');
  }

  const missing = [];
  if (!passA) missing.push('passA');
  if (!passB) missing.push('passB');
  if (!revision) missing.push('revision');

  return { kind, passA, passB, revision, warnings, missing, stats: { objects: objs.length } };
}

/** 复核：只认 passB（或裸四分数）。不再把它误判成 passA。 */
function parseReview(objs, { warnings }) {
  let candidate = null;
  for (const o of objs) {
    const r = firstKey(o, ENVELOPE_REVIEW);
    if (r && typeof r === 'object') { candidate = r; break; }
  }
  if (!candidate) {
    // 裸四分数对象，或者带点评但只给了一份的对象
    candidate = objs.find((o) => isScoresOnly(o)) || objs.find((o) => scoreKeysPresent(o) === 4) || null;
  }
  if (!candidate) {
    return {
      kind: 'review',
      passA: null,
      passB: null,
      revision: null,
      warnings: [...warnings, '复核结果里没有找到四个维度分数（需要 passB 或 {tr,cc,lr,ga}）'],
      missing: ['passB'],
    };
  }

  const v = validateReview(candidate);
  if (!v.ok) {
    return {
      kind: 'review',
      passA: null,
      passB: null,
      revision: null,
      warnings: [...warnings, `复核分数校验未通过：${v.issues}`],
      missing: ['passB'],
    };
  }

  if (objs.some((o) => firstKey(o, ENVELOPE_GRADE))) {
    warnings.push('复核结果里带了完整批改对象，已忽略，只取四个分数');
  }

  return {
    kind: 'review',
    passA: null,
    passB: v.data,
    revision: null,
    warnings,
    missing: [],
    stats: { objects: objs.length },
  };
}

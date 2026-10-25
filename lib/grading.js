import { chat } from './llm.js';
import { buildGradeMessages } from './prompts.js';
import {
  DIM_KEYS,
  ERROR_TAGS,
  ERROR_TYPES,
  TAG_TYPE,
  gradeResultSchema,
  reviewScoresSchema,
  mergePasses,
  overallOf,
  snap,
} from './contract.js';

// ---------------------------------------------------------------------------
// 容错：模型输出格式千奇百怪，先归一化再校验
// 但「容错」只容许格式差异，不容许猜分数。
// ---------------------------------------------------------------------------
const ALIASES = {
  tr: ['tr', 'TR', 'ta', 'TA', 'task_achievement', 'task_response', 'taskAchievement'],
  cc: ['cc', 'CC', 'coherence_cohesion', 'cohesion', 'coherenceCohesion'],
  lr: ['lr', 'LR', 'lexical_resource', 'lexical', 'lexicalResource'],
  ga: ['ga', 'GA', 'gra', 'GRA', 'grammatical_range_accuracy', 'grammatical_accuracy', 'grammaticalRange'],
};

/**
 * band 解析。只接受「有限数值」或「严格数字字符串」。
 * 明确拒绝：空值、""、"-6"、"80/100"、"6.5（Band 6.5）"、6.3、10、-1。
 * 以前会剥字符再猜，结果 "" → 0、"-6" → 6、"80/100" → 9，全是错分。
 */
export function toBand(v) {
  if (v == null) return null;
  if (typeof v === 'number') return bandOrNull(v);
  if (typeof v !== 'string') return null;

  const s = v.trim();
  if (!s) return null;
  // 严格十进制：可选正号 + 数字 + 可选小数。不带百分号、不带单位、不带说明文字。
  if (!/^\+?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return bandOrNull(n);
}

function bandOrNull(n) {
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 9) return null;
  if (Math.abs(n * 2 - Math.round(n * 2)) > 1e-9) return null;   // 必须 0.5 的整数倍
  return n;
}

/** 返回 { value, bad }：有合法值就返回 value，全部非法时 bad 记下原因 */
function pickDim(obj, key) {
  let bad = null;
  for (const a of ALIASES[key]) {
    if (obj[a] != null) {
      const b = toBand(obj[a]);
      if (b != null) return { value: b, bad: null };
      bad = `${key}=${JSON.stringify(obj[a])} 不是合法 band（要求 0~9、0.5 步进）`;
    }
  }
  return { value: null, bad };
}

function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null).map(String);
  return [String(v)];
}

export function normalize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const scoreSource = o.scores && typeof o.scores === 'object' ? { ...o.scores, ...o } : o;

  const out = {};
  const missing = [];
  const invalid = [];
  for (const k of DIM_KEYS) {
    const r = pickDim(scoreSource, k);
    if (r.value != null) out[k] = r.value;
    else if (r.bad) invalid.push(r.bad);   // 有值但不合法，和「压根没给」是两件事
    else missing.push(k);
  }

  // 逐维点评可能藏在 dims / detailed_analysis / dimensions 里
  const dimSource = o.dims || o.detailed_analysis || o.detailedAnalysis || o.dimensions || {};
  const dims = {};
  for (const k of DIM_KEYS) {
    const key = ALIASES[k].find((a) => dimSource[a] != null) || k;
    const d = dimSource[key];
    if (d && typeof d === 'object') {
      dims[k] = {
        comment: String(d.comment || d.details || d.analysis || ''),
        evidence: asArray(d.evidence || d.quotes),
        fix_example: String(d.fix_example || d.improvement_example || d.fixExample || ''),
      };
    } else if (typeof d === 'string') {
      dims[k] = { comment: d, evidence: [], fix_example: '' };
    } else {
      dims[k] = { comment: '', evidence: [], fix_example: '' };
    }
  }

  const errors = (Array.isArray(o.errors) ? o.errors : [])
    .map((e) => {
      const tag = String(e?.tag || '').toLowerCase().trim();
      return {
        type: TAG_TYPE[tag] || String(e?.type || '').toLowerCase().trim(),
        tag,
        count: Math.max(1, Math.round(Number(e?.count) || 1)),
        examples: asArray(e?.examples || e?.example).slice(0, 3),
      };
    })
    .filter((e) => ERROR_TYPES[e.type] && ERROR_TAGS[e.tag]);

  return {
    ...out,
    dims,
    errors,
    strengths: asArray(o.strengths).slice(0, 6),
    weaknesses: asArray(o.weaknesses).slice(0, 6),
    next_actions: asArray(o.next_actions || o.nextActions || o.suggestions).slice(0, 4),
    __missing: missing,
    __invalid: invalid,
  };
}

function extractJSON(text) {
  const s = String(text || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

const hasComment = (dims, k) => String(dims?.[k]?.comment || '').trim().length >= 4;

/** 四维里缺点评的维度列表 */
export function dimsWithoutComment(dims) {
  return DIM_KEYS.filter((k) => !hasComment(dims, k));
}

/**
 * 完整批改的契约校验：四个合法分数 + 四维点评。
 * kind:
 *   missing-scores  压根没给分
 *   invalid-scores  给了分但不是合法 band（6.3 / 80 / -6 / "" 之类）
 *   incomplete      分数齐了但没有点评 —— 这不是完整批改
 *   format          结构不对（可以交给 JSON 修复器）
 */
export function validateGrade(obj, { requireComments = true } = {}) {
  const norm = normalize(obj);

  if (norm.__missing.length) {
    return { ok: false, kind: 'missing-scores', issues: `缺少维度分数：${norm.__missing.join(' / ')}` };
  }
  if (norm.__invalid.length) {
    return { ok: false, kind: 'invalid-scores', issues: norm.__invalid.join('；') };
  }
  if (requireComments) {
    const noComment = dimsWithoutComment(norm.dims);
    if (noComment.length) {
      return {
        ok: false,
        kind: 'incomplete',
        issues: `只有分数、缺少逐维点评：${noComment.join(' / ')}。只有四个分数的对象属于「复核结果」，不能当完整批改落盘`,
      };
    }
  }

  const { __missing, __invalid, ...clean } = norm;
  const r = gradeResultSchema.safeParse(clean);
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    kind: 'format',
    issues: r.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
  };
}

/** 仅分数复核的契约：只认四个合法 band，不需要点评 */
export function validateReview(obj) {
  const norm = normalize(obj);
  if (norm.__missing.length) {
    return { ok: false, kind: 'missing-scores', issues: `复核结果缺少维度分数：${norm.__missing.join(' / ')}` };
  }
  if (norm.__invalid.length) {
    return { ok: false, kind: 'invalid-scores', issues: norm.__invalid.join('；') };
  }
  const r = reviewScoresSchema.safeParse({ tr: norm.tr, cc: norm.cc, lr: norm.lr, ga: norm.ga });
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    kind: 'format',
    issues: r.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
  };
}

export function tryParse(text, options) {
  const src = String(text || '');
  const json = extractJSON(src);
  if (!json) {
    // 空输出 = 生成失败（多半是 token 预算被 thinking 吃光），整份重跑
    return {
      ok: false,
      kind: src.trim() ? 'format' : 'incomplete',
      issues: src.trim() ? '输出里找不到 JSON 对象' : '模型没有返回正文（token 预算耗尽）',
    };
  }
  let obj;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    return { ok: false, kind: 'format', issues: `JSON 语法错误：${e.message}` };
  }
  return validateGrade(obj, options);
}

// ---------------------------------------------------------------------------
// 只修 JSON，不重新评分
// ---------------------------------------------------------------------------
async function repairJSON(text, issues, signal) {
  const r = await chat({
    messages: [
      {
        role: 'system',
        content: '你是 JSON 修复器。把用户给的内容修正成合法 JSON 并只输出这个 JSON，不要解释，不要代码块，不要重新评分。不要新增、不要猜测任何缺失的分数或点评。',
      },
      {
        role: 'user',
        content: `要求：四个维度分 tr/cc/lr/ga 必须齐全，取值是 0.5 的整数倍（如 6.0 / 6.5 / 7.0）；dims 含 tr/cc/lr/ga 四个对象；errors[].type 与 tag 必须在允许的枚举内。\n\n问题：${issues}\n\n待修复内容：\n${text}`,
      },
    ],
    json: true,
    temperature: 0,
    maxTokens: 4000,
    signal,
  });
  return r.text;
}

// 这些类别说明「生成本身不合格」，重跑一遍比修 JSON 可靠；
// 修复器只会替模型编一个数出来，那比失败更糟。
const REGENERATE_KINDS = new Set(['missing-scores', 'invalid-scores', 'incomplete']);

// ---------------------------------------------------------------------------
// 单次评分
// ---------------------------------------------------------------------------
export async function gradePass({ pass, task, prompt, essay, wordCount, images = [], signal, onPhase }) {
  const messages = buildGradeMessages(pass, {
    task,
    prompt,
    essay,
    wordCount,
    hasImage: images.length > 0,
  });

  const base = {
    messages,
    json: true,
    images,
    temperature: pass === 'B' ? 0.3 : 0,
    maxTokens: 5000,
    signal,
    onRetry: ({ attempt }) => onPhase?.({ type: 'retry', attempt }),
  };

  let res = await chat(base);
  let parsed = tryParse(res.text);

  // 被截断：加预算重跑，不修 JSON
  if (!parsed.ok && res.finishReason === 'length') {
    onPhase?.({ type: 'retry', attempt: 'length' });
    res = await chat({ ...base, maxTokens: 8000 });
    parsed = tryParse(res.text);
  }

  // 缺分数 / 分数非法 / 缺点评：整份重跑一次
  if (!parsed.ok && REGENERATE_KINDS.has(parsed.kind)) {
    onPhase?.({ type: 'retry', attempt: parsed.kind });
    const retry = await chat({
      ...base,
      messages: [
        ...messages,
        {
          role: 'user',
          content: '你上一次的输出不合格（缺分数、分数不是 0.5 步进、或缺少逐维点评）。这次必须：tr / cc / lr / ga 四个分数齐全且都是 0.5 的整数倍；dims 里 tr / cc / lr / ga 四个对象都要有 comment。不要只给四个数字。',
        },
      ],
    });
    const second = tryParse(retry.text);
    if (second.ok) {
      parsed = second;
      res = retry;
    } else {
      // 第二次仍不合格：保留更严重的那个原因，且绝不进入 JSON 修复器
      parsed = second.kind === 'format' ? parsed : second;
      throw new Error(`评分结果不合格（${pass} 次）：${parsed.issues}`);
    }
  }

  // 只剩结构/语法问题才交给修复器；它没有权限补分、补点评
  if (!parsed.ok) {
    if (parsed.kind !== 'format') {
      throw new Error(`评分结果不合格（${pass} 次）：${parsed.issues}`);
    }
    onPhase?.({ type: 'repair' });
    const fixed = await repairJSON(res.text, parsed.issues, signal);
    const repaired = tryParse(fixed);
    if (!repaired.ok) {
      throw new Error(`评分结果无法解析（${pass} 次）：${repaired.issues || parsed.issues}`);
    }
    parsed = repaired;
  }

  const data = parsed.data;
  return { data, overall: overallOf(data), raw: res.text, ms: res.ms, usage: res.usage };
}

// ---------------------------------------------------------------------------
// 合并两次评分
// ---------------------------------------------------------------------------
function dedupe(list, cap) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = String(item).trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= cap) break;
  }
  return out;
}

/** 这一份结果里有多少维带真实点评 */
function commentaryCount(p) {
  if (!p?.dims) return 0;
  return DIM_KEYS.filter((k) => String(p.dims[k]?.comment || '').trim().length >= 4).length;
}

/**
 * 逐维点评挑哪一份：先看谁有真点评，再比总分。
 * 只看总分会让「仅含分数的复核」用空点评覆盖掉完整批改的点评。
 */
function pickPrimary(a, b) {
  const ca = commentaryCount(a);
  const cb = commentaryCount(b);
  if (ca !== cb) return ca > cb ? a : b;
  return overallOf(a) >= overallOf(b) ? a : b;
}

export function combineResults(a, b) {
  const { score, raw, pass_overall, spread, boundary } = mergePasses(a, b);

  // 两次评的是同一篇，同一 tag 的错误数取较大值，不能相加。
  // 按 tag 归并（type 已由 TAG_TYPE 固定，tag 唯一决定 type）
  const map = new Map();
  for (const src of [a.errors || [], b.errors || []]) {
    for (const e of src) {
      const cur = map.get(e.tag) || { type: e.type, tag: e.tag, count: 0, examples: [] };
      cur.count = Math.max(cur.count, e.count);
      for (const ex of e.examples) {
        if (cur.examples.length < 2 && !cur.examples.includes(ex)) cur.examples.push(ex);
      }
      map.set(e.tag, cur);
    }
  }
  const errors = [...map.values()].sort((x, y) => y.count - x.count);

  const primary = pickPrimary(a, b);
  const other = primary === a ? b : a;

  return {
    score,
    raw,                       // 未舍入的维度均值，方便核对「只 round 一次」
    pass_overall,
    spread,
    boundary,
    errors,
    dims: primary.dims,
    strengths: dedupe([...(a.strengths || []), ...(b.strengths || [])], 5),
    weaknesses: dedupe([...(primary.weaknesses || []), ...(other.weaknesses || [])], 5),
    next_actions: dedupe([...(primary.next_actions || []), ...(other.next_actions || [])], 3),
  };
}

/**
 * 单评收尾：只有一次评分时不去编造第二次。
 * spread 显式置 null，让 UI 能区分「真一致」和「压根没做检测」。
 */
export function finalizeResults(a, b = null) {
  if (b) return combineResults(a, b);
  const score = {
    tr: snap(a.tr),
    cc: snap(a.cc),
    lr: snap(a.lr),
    ga: snap(a.ga),
  };
  score.overall = overallOf(score);
  return {
    score,
    raw: { tr: Number(a.tr), cc: Number(a.cc), lr: Number(a.lr), ga: Number(a.ga) },
    pass_overall: [overallOf(a)],
    spread: null,
    boundary: false,
    errors: a.errors || [],
    dims: a.dims,
    strengths: a.strengths || [],
    weaknesses: a.weaknesses || [],
    next_actions: a.next_actions || [],
  };
}

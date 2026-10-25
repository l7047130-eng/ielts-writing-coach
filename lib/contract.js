import { z } from 'zod';

// ---------------------------------------------------------------------------
// 1. 与 ielts-dashboard/lib/schema.js 保持一致的落盘契约
//    改动这里之前先看 <dash>/lib/scanner.js 的 loadWriting()：
//    校验失败的文件会被「静默跳过」，用户会以为记录丢了。
// ---------------------------------------------------------------------------
export const writingSubmissionSchema = z.object({
  date: z.string(),
  task: z.union([z.literal(1), z.literal(2)]),
  topic: z.string(),
  score: z.object({
    tr: z.number(),
    cc: z.number(),
    lr: z.number(),
    ga: z.number(),
    overall: z.number(),
  }),
  errors: z.array(z.object({
    type: z.string(),
    tag: z.string(),
    count: z.number(),
  })).default([]),
  duration_min: z.number().optional(),
  word_count: z.number().optional(),
});

export function assertSubmission(obj) {
  const r = writingSubmissionSchema.safeParse(obj);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new Error(`落盘数据结构不合法，已阻止写入（否则老看板会静默跳过）：${issues}`);
}

// ---------------------------------------------------------------------------
// 2. 四维与错误标签（与 src/labels.js 对齐，提示词里也会用到）
// ---------------------------------------------------------------------------
export const DIM_KEYS = ['tr', 'cc', 'lr', 'ga'];

export const DIM_LABELS = {
  tr: { short: 'TA/TR', cn: '任务回应', full: 'Task Achievement / Task Response' },
  cc: { short: 'CC', cn: '连贯与衔接', full: 'Coherence & Cohesion' },
  lr: { short: 'LR', cn: '词汇资源', full: 'Lexical Resource' },
  ga: { short: 'GA', cn: '语法多样性与准确性', full: 'Grammatical Range & Accuracy' },
};

export const ERROR_TYPES = {
  grammar: '语法',
  lexical: '词汇',
  cohesion: '衔接',
  task_response: '切题',
  coherence: '连贯',
};

// 只允许写这 15 个 tag，老看板的「高频错误 Top 10」才统计得出来
export const ERROR_TAGS = {
  prep_collocation: '介词搭配',
  tense_shift: '时态乱跳',
  weak_argument: '论证弱',
  article_misuse: '冠词错',
  word_form: '词性错',
  incomplete_answer: '答题不完整',
  subj_verb_agree: '主谓不一致',
  linker_overuse: '连接词过度',
  basic_vocabulary: '词汇基础',
  conditional: '条件句错',
  copy_question: '抄题目',
  informal_register: '口语化',
  passive_overuse: '被动语态过度',
  run_on: '流水句',
  paragraph_structure: '段落结构',
};

// 每个 tag 固定归属一个 type。归一化时按这张表强制改写，
// 避免模型把 weak_argument 同时挂到 coherence 和 task_response 上。
export const TAG_TYPE = {
  incomplete_answer: 'task_response',
  weak_argument: 'task_response',
  copy_question: 'task_response',
  paragraph_structure: 'coherence',
  linker_overuse: 'cohesion',
  basic_vocabulary: 'lexical',
  word_form: 'lexical',
  informal_register: 'lexical',
  prep_collocation: 'lexical',
  tense_shift: 'grammar',
  article_misuse: 'grammar',
  subj_verb_agree: 'grammar',
  conditional: 'grammar',
  passive_overuse: 'grammar',
  run_on: 'grammar',
};

// ---------------------------------------------------------------------------
// 3. 雅思 band 计算
//    四维先跨两次平均，再算 overall，全程只 round 一次。
//    先各自算 overall 再平均会多一次舍入，边界更容易漂 0.5。
// ---------------------------------------------------------------------------
export const BAND_STEP = 0.5;

/** 合法 band：有限数、0–9、0.5 的整数倍 */
export function isBand(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  if (n < 0 || n > 9) return false;
  return Math.abs(n / BAND_STEP - Math.round(n / BAND_STEP)) < 1e-9;
}

export const snap = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + 1e-9) * 2) / 2;
};

export function overallOf(d) {
  const mean = (Number(d.tr) + Number(d.cc) + Number(d.lr) + Number(d.ga)) / 4;
  if (!Number.isFinite(mean)) return 0;
  return Math.min(9, Math.max(0, snap(mean)));
}

/**
 * 合并两次评分。
 * 计算规则：四维先取**未舍入**的平均值，综合分由这四个平均值算，最后统一 round 一次。
 * 展示/落盘仍给半分制的四维（老看板按半分读），但 `raw` 保留精确均值，
 * 这样「计算值」和「展示值」分得开，不会因为先舍入维度再平均而漂 0.5。
 */
export function mergePasses(a, b) {
  const avg = (k) => (Number(a[k]) + Number(b[k])) / 2;
  const raw = { tr: avg('tr'), cc: avg('cc'), lr: avg('lr'), ga: avg('ga') };

  for (const k of DIM_KEYS) {
    if (!Number.isFinite(raw[k])) {
      throw new Error(`合并评分失败：${k} 不是有效数字`);
    }
  }

  const score = {
    tr: snap(raw.tr),
    cc: snap(raw.cc),
    lr: snap(raw.lr),
    ga: snap(raw.ga),
  };
  // 只在这里 round 一次
  const mean = (raw.tr + raw.cc + raw.lr + raw.ga) / 4;
  score.overall = Math.min(9, Math.max(0, snap(mean)));

  const pa = overallOf(a);
  const pb = overallOf(b);
  const spread = Math.abs(pa - pb);
  return { score, raw, pass_overall: [pa, pb], spread, boundary: spread >= 0.5 };
}

/** 复核（单次新评分 + 已存档评分）也走同一条合并路径 */
export function mergeWithReview(a, b) {
  return mergePasses(a, b);
}

// 落盘前把浮点收拾干净，避免 YAML 出现 6.499999999
export const toHalf = (x) => Number(snap(Number(x)).toFixed(1));

// ---------------------------------------------------------------------------
// 4. 模型输出的结构校验
//    两条不同的契约：
//    - gradeResultSchema：完整批改，四维分数 + 四维点评
//    - reviewScoresSchema：仅分数复核，只有四个分数
//    混用会让「只有四个分数」的对象冒充完整批改写进正式成绩。
// ---------------------------------------------------------------------------
const bandSchema = z.number()
  .finite('分数必须是有限数值')
  .min(0, '分数不能小于 0')
  .max(9, '分数不能大于 9')
  .refine(isBand, { message: '分数必须是 0.5 的整数倍' });

const dimDetailSchema = z.object({
  comment: z.string().default(''),
  evidence: z.array(z.string()).default([]),
  fix_example: z.string().default(''),
});

export const reviewScoresSchema = z.object({
  tr: bandSchema,
  cc: bandSchema,
  lr: bandSchema,
  ga: bandSchema,
});

export const gradeResultSchema = z.object({
  tr: bandSchema,
  cc: bandSchema,
  lr: bandSchema,
  ga: bandSchema,
  dims: z.record(dimDetailSchema).default({}),
  errors: z.array(z.object({
    type: z.string(),
    tag: z.string(),
    count: z.number(),
    examples: z.array(z.string()).default([]),
  })).default([]),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  next_actions: z.array(z.string()).default([]),
});

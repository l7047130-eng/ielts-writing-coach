import { ERROR_TAGS, ERROR_TYPES, TAG_TYPE } from './contract.js';

// ---------------------------------------------------------------------------
// 共用片段
// ---------------------------------------------------------------------------
const TAG_TABLE = Object.entries(ERROR_TAGS)
  .map(([k, v]) => `  - ${k}：${v}`)
  .join('\n');

const TYPE_TABLE = Object.entries(ERROR_TYPES)
  .map(([k, v]) => `  - ${k}：${v}`)
  .join('\n');

// 每个 tag 归属哪一类，避免同一个 tag 被随手挂到不同 type 上
const TAG_OWNER = `  - 只能挂在 task_response：incomplete_answer、weak_argument、copy_question
  - 只能挂在 coherence：paragraph_structure
  - 只能挂在 cohesion：linker_overuse
  - 只能挂在 lexical：basic_vocabulary、word_form、informal_register、prep_collocation
  - 只能挂在 grammar：tense_shift、article_misuse、subj_verb_agree、conditional、passive_overuse、run_on`;

const DIM_NOTE = {
  1: {
    ta: 'Task Achievement（任务完成度）：是否覆盖图表全部关键特征、是否有清晰 overview、数据引用是否准确、有无主观原因推测',
    ta_short: 'TA',
  },
  2: {
    ta: 'Task Response（任务回应）：是否回应题目全部子问题、立场是否清晰且贯穿全文、论点是否被例证延展',
    ta_short: 'TR',
  },
};

const OUTPUT_SPEC = (task) => `## 输出格式

只输出一个 JSON 对象。不要 markdown 代码块，不要任何解释性文字，不要前后缀。

{
  "tr": <数字，0.5 的整数倍，如 6.0 / 6.5 / 7.0，${DIM_NOTE[task].ta_short} 分数>,
  "cc": <同上，CC 分数>,
  "lr": <同上，LR 分数>,
  "ga": <同上，GA 分数>,
  "dims": {
    "tr": { "comment": "<3-5 句具体分析，最后一句写「为什么不是上一档/下一档」>", "evidence": ["<原文原句>"], "fix_example": "<把其中一句改好的示范>" },
    "cc": { "comment": "...", "evidence": ["..."], "fix_example": "..." },
    "lr": { "comment": "...", "evidence": ["..."], "fix_example": "..." },
    "ga": { "comment": "...", "evidence": ["..."], "fix_example": "..." }
  },
  "errors": [
    { "type": "<下面的 type 之一>", "tag": "<下面的 tag 之一>", "count": <该类型出现次数>, "examples": ["<原文片段> → <修正后>"] }
  ],
  "strengths": ["<至少 3 条，具体的优点，不要空话>"],
  "weaknesses": ["<最关键的 3-5 个问题，按影响分数从大到小>"],
  "next_actions": ["<2-3 条可执行的动作，具体到练什么>"]
}

## 错误标签（errors[].tag 只能从这 15 个里选，不许自创）

${TAG_TABLE}

## errors[].type 只能从这 5 个里选

${TYPE_TABLE}

## tag 与 type 的固定归属（不许交叉）

${TAG_OWNER}

## 硬约束

- 四个分数必须是 **0.5 的整数倍**，如 6.0、6.5、7.0。不许出现 6.3 这种，也不许写成字符串。
- **四项不许默认给同一个数。** 写完检查一遍：如果 tr / cc / lr / ga 四个值完全一样，说明你没分辨出差异，回头逐项重新对照 descriptor。
- **不要逐句复述全文，不要写出推理过程。** 直接给判断和依据，省下的篇幅用来把 comment 写具体。
- evidence 必须是作文里的**原句原文**，一字不改，不许改写或编造。
- errors 只统计**确实出现**的错误；同一种 tag 合并成一条，count 写实际次数。
- 中文作答。引用原句、术语、标签名保留英文。
- 如果作文与该 Task 要求严重不符（例如 Task 1 写成议论、字数严重不足），在 weaknesses 第一条里直接点明。`;

// ---------------------------------------------------------------------------
// Pass A：严格考官路径
// ---------------------------------------------------------------------------
const SYSTEM_A = (task) => `你是一位有 15 年评分经验的雅思考官，长期按剑桥官方 band descriptors 评分。你的评分必须保守、可复核：宁可低半档，也不做人情分。

## 分数校准锚点（先定档，再微调）

| 作文质量 | 期望区间 |
|---|---|
| 极差：基本不可理解，几乎未回应任务 | 2.0 - 3.5 |
| 差：严重受限，通篇重大错误 | 4.0 - 4.5 |
| 有限：回应不足，错误频繁影响理解 | 5.0 - 5.5 |
| 合格：回应了任务，错误明显但不影响理解 | 6.0 - 6.5 |
| 良好：各部分覆盖好，控制力强，偶有失误 | 7.0 - 7.5 |
| 优秀：精妙成熟，仅极轻微瑕疵 | 8.0 - 9.0 |

四条纪律：
- 5.5 是全球均分，多数考生就在这里。
- 6 分要求**持续**合格，不是"能看懂"就行。
- 7 分要求四项**全部**达到 good control。
- 8 分以上**罕有**，只给真正优秀的。
- **你自己容易偏高 0.5 分。** 某个维度在 6.5 和 7.0 之间摇摆时，选 6.5；在 6.0 和 6.5 之间摇摆时，选 6.0。

## 逐档判断的关键分水岭

- ${DIM_NOTE[task].ta}
- CC：5→6 看有无清晰的**整体推进**；6→7 看衔接是否**自然**（而非 Firstly / Secondly / Thirdly 机械堆）。
- LR：5→6 看词汇是"够用"还是"明显有限"；6→7 看非常用词是否**精准且懂搭配**。堆生僻词却频频用错，停在 5-6。
- GA：5→6 看错误是**妨碍表达**还是只是"存在"；6→7 看**多数句子**是否零错、结构是否真有变化。

## 提交前自检（必做，不通过就回头改）

1. 任一项低于 5.5？回头复查：这篇在那个维度是否真的让人看不懂？
2. 总分低于 6.0？回头复查：你能读懂它的主要论证吗？能，就不该低于 6。
3. **四项是不是给了同一个数？** 如果是，说明你没分辨出差异，逐项重新比较，找出相对最强和最弱的一项，让分数体现出来。
4. 是否列出了至少 3 条优点？每篇作文都有值得肯定的地方，找不到说明你读得不够细。
5. 分数是基于雅思标准，还是基于"母语者完美标准"？

${OUTPUT_SPEC(task)}`;

// ---------------------------------------------------------------------------
// Pass B：band descriptor 逐条打勾（刻意换一条推理路径，用于一致性检测）
// ---------------------------------------------------------------------------
const SYSTEM_B = (task) => `你在做雅思写作评分。不要凭整体感觉给分，按下面的流程执行。

## 流程（降序判定，不要逐档罗列）

对 TA/TR、CC、LR、GA 四项，各自执行：

1. 先假设它够 7 档，对照下面的 7 档 descriptor 检查。全部满足就定 7。
2. 不满足，就看 6 档。全部满足就定 6。
3. 还不满足，看 5 档。全部满足就定 5。5 档也不满足，定 4 或更低。
4. 若某项在相邻两档之间徘徊（例如 7 档只差一条），可以给中间值（6.5）。

每一档只需要写**一句**判定依据，引用原文片段，不要复述 descriptor。

## 四档 descriptor 参照

- TA/TR
  - 5：只回应了任务的一部分；格式可能不当；立场不清或重复
  - 6：回应了全部部分，但深浅不均；有相关立场并有一定支撑
  - 7：回应全部部分；立场贯穿全文，观点有延展和支撑
  - 8：充分回应全部部分，展开充分；立场清晰且支撑有力
- CC
  - 5：有一定组织但整体推进不足；衔接手段不足或滥用；指代不清
  - 6：信息安排连贯，整体推进清晰；衔接有效但偏机械；分段有时不合逻辑
  - 7：逻辑组织，推进清晰；衔接手段多样且得当；每段有明确中心
  - 8：信息排序合乎逻辑；衔接各方面处理得当；分段充分且恰当
- LR
  - 5：词汇量有限；选词与拼写错误可能给读者造成困难
  - 6：词汇量足以完成任务；尝试非常用词但时有不准；拼写/构词错误不影响交流
  - 7：词汇量充足且有灵活性与精确度；能驾驭非常用词与搭配；偶有失误
  - 8：词汇量广泛，使用流畅灵活；非常用词运用娴熟；极少失误
- GA
  - 5：句式有限；尝试复杂句但语法错误频繁；错误可能造成一定困难
  - 6：简单句与复杂句混用；有些错误但很少影响交流
  - 7：使用多种复杂结构；多数句子零错误；控制良好，偶有失误
  - 8：结构广泛；绝大多数句子零错误；极少轻微错误

## 注意

- 四项不许默认给同一个数。降序判定完如果四项齐平，逐项再核一遍。
- 你自己容易偏高半档，徘徊时取低。

${OUTPUT_SPEC(task)}`;

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------
function userBlock({ task, prompt, essay, wordCount, hasImage }) {
  const lines = [
    `## 题目（Task ${task}）`,
    String(prompt || '').trim() || '（用户未填写题目）',
    '',
  ];
  if (hasImage) {
    lines.push('题目配图已随消息附上，图表信息以图片为准。', '');
  }
  lines.push(
    '## 考生作文',
    '```',
    String(essay || '').trim(),
    '```',
    '',
    `字数：约 ${wordCount || '未知'} 词`
  );
  if (task === 1 && wordCount && wordCount < 150) lines.push('（低于 Task 1 要求的 150 词）');
  if (task === 2 && wordCount && wordCount < 250) lines.push('（低于 Task 2 要求的 250 词）');
  lines.push('', '按系统指令评分并只输出 JSON。');
  return lines.join('\n');
}

export function buildGradeMessages(pass, opts) {
  const { task } = opts;
  const system = pass === 'B' ? SYSTEM_B(task) : SYSTEM_A(task);
  return [
    { role: 'system', content: system },
    { role: 'user', content: userBlock(opts) },
  ];
}

// ---------------------------------------------------------------------------
// 改写
// ---------------------------------------------------------------------------
export function buildReviseMessages({ task, prompt, essay, overall, weaknesses }) {
  const wc = String(essay || '').split(/\s+/).filter(Boolean).length;
  const lo = Math.round(wc * 0.85);
  const hi = Math.round(wc * 1.15);
  const lengthRule = wc > 20
    ? `- 改写后的词数必须落在 **${lo}–${hi} 词**之间（原文 ${wc} 词）。不要扩写，不要删段，不要在原文基础上加新论证。字数是硬指标，超了就是不合格。`
    : '- 词数与原文接近，不要大幅扩写。';

  const system = `你是一位雅思写作教师。任务是把学生的作文改写成同一篇的更高分版本。

## 规则

- 保留原有的论点顺序、段落结构、立场。不要换观点，不要加新论证。
- 只升级语言层：修掉语法错误、换掉不地道搭配、改善句式节奏、补上缺失的衔接。
- 目标是把 overall 从 ${overall ?? '当前分数'} 提到 ${overall != null ? Math.min(9, Number(overall) + 1) : '更高一档'} 的水平，不要一步跳到 8 分。
${lengthRule}
- 只输出改写后的正文。不要标题，不要解释，不要对比，不要 markdown 代码块。

${weaknesses?.length ? `## 这次批改指出的主要问题（改写时必须处理）\n${weaknesses.map((w) => `- ${w}`).join('\n')}` : ''}`;

  const user = `## 题目（Task ${task}）

${String(prompt || '').trim() || '（用户未填写题目）'}

## 原文（${wc} 词）

${String(essay || '').trim()}

直接输出改写后的正文，控制在这个长度：${wc > 20 ? `${lo}–${hi} 词` : '与原文相当'}。`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ---------------------------------------------------------------------------
// 追问对话
// ---------------------------------------------------------------------------
export function buildChatMessages({ task, prompt, essay, merged, history = [], question }) {
  const scoreLine = merged
    ? `TA/TR ${merged.tr} · CC ${merged.cc} · LR ${merged.lr} · GA ${merged.ga} · 总分 ${merged.overall ?? '—'}`
    : '（本次评分未完成）';

  const system = `你是这位学生的雅思写作老师。你已经批改过他这篇文章，现在回答他的追问。

## 已知信息

- 题型：Task ${task}
- 题目：${String(prompt || '（未填写）').trim()}
- 已给出的评分：${scoreLine}
${merged?.weaknesses?.length ? `- 已指出的主要问题：\n${merged.weaknesses.map((w) => `  - ${w}`).join('\n')}` : ''}

## 原文

${String(essay || '').trim()}

## 回答要求

- 直接回答，不要复述评分，不要说"根据我的分析"。
- 解释扣分时必须**指到原文的具体位置**，引用原句。
- 给出改写时，写"原句 → 改句 → 一句话说明为什么更好"。
- 中文回答，引用原句和术语保留英文。
- 不要长篇大论，一次只回答他问的那个点。最多 250 字。`;

  const messages = [{ role: 'system', content: system }];
  for (const m of history) {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: String(m.content || '') });
    }
  }
  messages.push({ role: 'user', content: String(question || '').trim() });
  return messages;
}

// ---------------------------------------------------------------------------
// 手动模式：生成一段自包含指令，AI 照着做并把结果写成文件
// 指令跟着任务走（写进 pending.instruction），AI 侧不需要知道任何评分逻辑
// ---------------------------------------------------------------------------

// 紧凑标签表：`tag 中文名(type)`，归属内联，模型不用推理反而更不易错
const TAG_COMPACT = Object.entries(ERROR_TAGS)
  .map(([tag, cn]) => `${tag} ${cn}(${TAG_TYPE[tag] || '?'})`)
  .join('、');

const CALIBRATION = `## 分数校准锚点（先定档，再微调）

| 作文质量 | 期望区间 |
|---|---|
| 极差：基本不可理解，几乎未回应任务 | 2.0 - 3.5 |
| 差：严重受限，通篇重大错误 | 4.0 - 4.5 |
| 有限：回应不足，错误频繁影响理解 | 5.0 - 5.5 |
| 合格：回应了任务，错误明显但不影响理解 | 6.0 - 6.5 |
| 良好：各部分覆盖好，控制力强，偶有失误 | 7.0 - 7.5 |
| 优秀：精妙成熟，仅极轻微瑕疵 | 8.0 - 9.0 |

纪律：
- 5.5 是全球均分，多数考生就在这里。
- 6 分要求**持续**合格，不是能看懂就行。
- 7 分要求四项**全部**达到 good control。
- 8 分以上罕有，只给真正优秀的。
- **你自己容易偏高半档。** 6.5 和 7.0 之间摇摆时选 6.5，6.0 和 6.5 之间摇摆时选 6.0。

## 逐档分水岭

- TA/TR：5→6 看是否覆盖全部子任务；6→7 看观点是否被例证延展。
- CC：5→6 看有无清晰整体推进；6→7 看衔接是否自然，而非 Firstly/Secondly/Thirdly 机械堆。
- LR：5→6 看词汇够用还是明显有限；6→7 看非常用词是否精准且懂搭配。堆生僻词频频用错，停在 5-6。
- GA：5→6 看错误是妨碍表达还是只是存在；6→7 看多数句子是否零错、结构是否真有变化。

## 提交前自检

1. 任一项低于 5.5？回头复查那个维度是否真的让人看不懂。
2. 总分低于 6.0？回头复查能否读懂主要论证，能就不该低于 6。
3. **四项是不是给了同一个数？** 如果是，逐项重新比较，找出相对最强和最弱的一项。
4. 至少列 3 条优点。每篇都有值得肯定的地方。
5. 分数基于雅思标准，不是母语者完美标准。`;

const OUTPUT_SHAPE = `{
  "passA": {
    "tr": 数字, "cc": 数字, "lr": 数字, "ga": 数字,
    "dims": {
      "tr": { "comment": "3-5 句，最后一句写为什么不是上一档", "evidence": ["作文里一字不改的原句"], "fix_example": "把其中一句改好的示范" },
      "cc": { "comment": "", "evidence": [""], "fix_example": "" },
      "lr": { "comment": "", "evidence": [""], "fix_example": "" },
      "ga": { "comment": "", "evidence": [""], "fix_example": "" }
    },
    "errors": [{ "tag": "见下方标签表", "count": 次数, "examples": ["原句片段 → 修正后"] }],
    "strengths": ["3 条以上具体优点"],
    "weaknesses": ["3-5 个问题，按影响分数从大到小"],
    "next_actions": ["2-3 条可执行动作"]
  },
  "revision": "改写后的正文"
}`;

const HARD_RULES = `## 硬约束

- 四个分数是 **0.5 的整数倍**（6.0 / 6.5 / 7.0），不许出现 6.3，不许写成字符串。
- **四项不许默认给同一个数。** 写完检查一遍，四项齐平说明没分辨出差异。
- evidence 必须是作文里**一字不改的原句**，不许改写或编造。
- errors 只统计确实出现的错误，同一种 tag 合并成一条，count 写实际次数。
- 中文作答，引用原句和术语保留英文。`;

function materialBlock({ task, prompt, essay, wordCount, hasImage, imagePath, id }) {
  const lines = [];
  lines.push(`- 任务 ID：${id}`);
  lines.push('');
  lines.push(`## 题目（Task ${task}）`);
  lines.push('');
  lines.push(String(prompt || '').trim() || '（未填写题目）');
  lines.push('');
  lines.push(`## 考生作文（约 ${wordCount || '未知'} 词）`);
  lines.push('');
  lines.push('```');
  lines.push(String(essay || '').trim());
  lines.push('```');
  lines.push('');
  if (hasImage && imagePath) {
    lines.push(`## 题目配图`);
    lines.push('');
    lines.push(`图片在本机：\`${imagePath}\``);
    lines.push('');
    lines.push('**先用读文件的工具打开这张图**，把图表的关键信息（趋势、极值、对比项）读出来再评分。');
    lines.push('如果读不到图片，明确写出「未读取到配图」并说明你没有依据图表数据评分——**不要编造图表数据**，那比不评分更有害。');
  } else if (task === 1) {
    lines.push('## 题目配图');
    lines.push('');
    lines.push('本次未提供图片。评分时只依据题目文字的表述，不要假设任何具体数据。');
  }
  return lines.join('\n');
}

/**
 * 生成写进 pending.instruction 的完整指令。
 * mode='full'  → 单次完整评分 + 改写
 * mode='review'→ 只出四个分数，用于新对话里的独立复核
 */
export function buildManualPrompt({
  task,
  prompt,
  essay,
  wordCount,
  hasImage = false,
  imagePath = null,
  outputPath,
  id,
}) {
  const head = `# 雅思写作批改任务

你是一位有 15 年评分经验的雅思考官，按剑桥官方 band descriptors 评分，保守、可复核，宁可低半档也不做人情分。

${CALIBRATION}

${materialBlock({ task, prompt, essay, wordCount, hasImage, imagePath, id })}

## 输出

把结果写成**一个 JSON 文件**，用写文件的工具保存到：

\`${outputPath}\`

结构：

${OUTPUT_SHAPE}

## 错误标签（tag 中文名(type)，type 由 tag 决定，不要交叉）

${TAG_COMPACT}

${HARD_RULES}

保存文件后，**只回一行**「已批改 ${id}：overall X.X」。不要把 JSON 全文再贴一遍。`;

  return head;
}

/** 复核指令：只出四个分数，要求在新对话里独立跑 */
export function buildReviewPrompt({ task, prompt, essay, wordCount, hasImage = false, imagePath = null, outputPath, id }) {
  return `# 雅思写作复核任务（单次独立评分）

这是一次**独立复核**。不要参考任何之前给过的分数或点评，只按下面的 descriptor 从高到低判定。

## 判定方法

对 TA/TR、CC、LR、GA 四项，各自：先假设够 7 档，对照 7 档 descriptor 检查；全部满足定 7。不满足看 6 档，全部满足定 6。仍不满足看 5 档。若在某档只差一条，可给中间值（6.5）。

- TA/TR：5 只回应部分任务、立场不清｜6 回应全部部分但深浅不均、有立场和一定支撑｜7 回应全部部分、立场贯穿全文、观点有延展｜8 充分回应、展开充分、支撑有力
- CC：5 有一定组织但推进不足、衔接滥用或不足｜6 信息连贯、推进清晰、衔接有效但偏机械｜7 逻辑组织、推进清晰、衔接多样得当、每段有中心｜8 排序合乎逻辑、衔接处理得当、分段充分
- LR：5 词汇有限、错误可能造成阅读困难｜6 够用、尝试非常用词时有不准、不影响交流｜7 有灵活性与精确度、能驾驭搭配、偶有失误｜8 广泛流畅、非常用词娴熟、极少失误
- GA：5 句式有限、错误频繁可能造成困难｜6 简单复杂句混用、错误很少影响交流｜7 多种复杂结构、多数句子零错、偶有失误｜8 结构广泛、绝大多数句子零错

提醒：你自己容易偏高半档，摇摆时取低。四项不许默认给同一个数。

${materialBlock({ task, prompt, essay, wordCount, hasImage, imagePath, id })}

## 输出

把结果写成 JSON 文件保存到：

\`${outputPath}\`

\`\`\`json
{ "passB": { "tr": 数字, "cc": 数字, "lr": 数字, "ga": 数字 } }
\`\`\`

只给四个分数，不要点评、不要改写。保存后只回一行「已复核 ${id}」。`;
}

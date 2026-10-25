# 雅思写作批改 · Agent 操作手册

**触发词：`开始`**（也认「批改队列」「跑队列」）

把这份文档交给任意一个能读写本地文件的 agent，它看到「开始」两个字就按下面的流程接手。
**评分标准不在本文档里**——在每一个任务文件的 `instruction` 字段里。你的职责是搬运与校验，不是重新设计评分。

---

## 一、触发后立刻执行的流程

### 第 1 步：看队列

列目录 `C:\Users\cy\.ielts\writing\queue\pending\`，取所有 `.json`。

- 空 → 回一句「队列是空的，没有待批改的作文」，结束。
- **不要**自己去项目目录里翻作文，只处理 pending 里明确排队的任务。
- 只管 `pending/`，不要动 `done/` `failed/` `claims/` `imported/`。

### 第 2 步：逐个处理（一个做完再做下一个，绝不合并成一次输出）

对每个 `<id>.json`：

1. **读文件**，取 `instruction` 字段。这就是完整的评分指令（含分数校准表、逐档分水岭、提交前自检、15 个错误标签、JSON 输出结构）。照它执行，不要凭自己的理解加戏。
2. **看 `kind`**：
   - `full` → 完整批改，输出 `passA`（四维分数 + 四维点评）+ 可选 `revision`
   - `review` → 复核，只输出 `passB`（四个分数，不要点评、不要改写）
3. **看 `image_path`**。非空时，先用读文件的工具打开那张图，把图表的关键数据（趋势、极值、对比项）读出来再评分。
   - 读不到图 → 按 instruction 的要求明确写「未读取到配图」，说明你没有依据图表数据评分。
   - **不要编造图表数据**，那比不评分更有害。
4. **生成 JSON，先写临时文件再改名**：写到同目录的 `<id>.json.tmp`，写完再 `rename` 成 `<id>.json`。
   网站会边写边读，直接写目标文件可能出现「半截 JSON」被判失败。
5. 只写 `output_path` 指定的那一个文件，别顺手改别的。

### 第 3 步：汇报

全部处理完，回一行：

```
处理 2 篇：20261024_task2_ageing overall 6.0；20261024_task1_chart overall 5.5
```

### 第 4 步：放手

- **不要删** `pending/` 里的文件。网站 ingest 成功后会自己清。
- **不要碰** `~/.ielts/writing/submissions/`。那是网站 ingest 时写的，重复写会产生重复记录。
- 不要写 `failed/`、`claims/`、`imported/`——这三个目录归网站管。

---

## 二、目录与文件契约

```
C:\Users\cy\.ielts\writing\queue\
├─ pending\<id>.json     网站写 → 你读
├─ done\<id>.json        你写 → 网站读
├─ failed\<id>.json      校验不通过时网站写（你不用管，但坏结果会被它记住）
├─ claims\<id>.json      ID 占位（你不用管）
├─ imported\<id>.json    已导入标记（你不用管）
└─ attachments\          Task 1 的题目图
```

> 根目录默认是 `%USERPROFILE%\.ielts\writing\queue`，如果网站启动时设了 `IELTS_HOME` 环境变量则随之改变。

### `pending/<id>.json` 的字段

| 字段 | 含义 |
|---|---|
| `id` | 任务标识，也是 `done/` 下的文件名 |
| `kind` | `full` = 完整批改；`review` = 只出四个分数的复核 |
| `assessment_id` | 仅 `kind=review`：复核针对的那条记录 id |
| `task` | `1` 或 `2` |
| `topic` / `prompt` / `essay` | 话题标签、题目原文、作文原文 |
| `word_count` | 网站算好的词数 |
| `image_path` | 题目图的绝对路径，可能是 `null`。**服务端生成，你只读不写**，只可能是 `queue/attachments/` 或该记录 `assessments/<id>/` 里的图片 |
| **`instruction`** | **完整评分指令，照它做** |
| `output_path` | 你必须写入的绝对路径 |

---

## 三、输出形状

`instruction` 里已经写了完整的 JSON 结构，这里给个参照。

**完整批改（`kind=full`）**

```json
{
  "passA": {
    "tr": 6.0, "cc": 5.5, "lr": 6.0, "ga": 5.5,
    "dims": {
      "tr": { "comment": "……最后一句写为什么不是上一档", "evidence": ["作文里一字不改的原句"], "fix_example": "把其中一句改好的示范" },
      "cc": { "comment": "……", "evidence": ["……"], "fix_example": "……" },
      "lr": { "comment": "……", "evidence": ["……"], "fix_example": "……" },
      "ga": { "comment": "……", "evidence": ["……"], "fix_example": "……" }
    },
    "errors": [{ "tag": "article_misuse", "count": 3, "examples": ["a → the"] }],
    "strengths": ["至少 3 条具体优点"],
    "weaknesses": ["3-5 个问题，按影响分数从大到小"],
    "next_actions": ["2-3 条可执行动作"]
  },
  "revision": "改写后的正文"
}
```

**复核（`kind=review`）**

```json
{ "passB": { "tr": 6.5, "cc": 6.0, "lr": 6.0, "ga": 6.0 } }
```

五条硬指标（网站的校验器会检查）：

- 分数必须是 **0.5 的整数倍**（6.0 / 6.5 / 7.0），`6.3` 会被直接拒收。
- 分数必须是 0–9 的**数字**。`"6.5"` 这种严格数字字符串可以，`"6.5（Band 6.5）"`、`"80/100"`、`"-6"`、`""` 都不行。
- 四个维度都要有，缺一个就判失败——不会帮你补 0。
- `dims` 里四维都要有**非空 `comment`**。只有四个分数、没有点评的对象属于「复核结果」，不能当完整批改落盘。
- `evidence` 必须是作文里**一字不改**的原句。全部对不上会触发「粘错作文」保护，整份被拒收。

`revision` 可选，词数控制在原文的 **85%–115%**，不要扩写。`passB` 只在 `kind=review` 时出现。

---

## 四、失败怎么处理

**不要写 `output_path`。** 在回复里说明哪个文件、为什么失败（读不到图、题目无法解析、作文为空……），让人来判断。

网站侧的行为：

- 没有 done 文件 → 等待页继续等（页面可以「稍后再弄」，任务留在磁盘上）
- done 文件不是合法 JSON 且过了几秒 → 判定 `failed`，页面停止轮询并显示原因
- done 文件合法但校验不过（缺维度、缺点评、分数不是半步进、引用全对不上）→ 写 `failed/<id>.json`，页面显示具体原因
- 落盘阶段失败（图片路径越界、图片不存在、类型不对、复制失败、发布失败）→ **整体回滚，不会留下半个正式成绩**，队列同样标为 `failed`，原因写进 `failed/<id>.json`
- 极端情况「发布失败且回滚也失败」→ 错误码 `EPERSIST_ROLLBACK_FAILED`，原记录可能暂时读不到，但完整备份留在 `assessments/.recovery/<id>.bak-*`。**这份备份不会被自动清理**，人工把它改名回 `assessments/<id>` 即可恢复

想重试：**修好材料再重新 ingest 一次就行**。可以改 `done/<id>.json`，也可以改 `pending/<id>.json` 里的路径字段——网站会对比文件指纹，发现换过就重新放行；页面上点「重新检查结果」即可，不用重建任务。成功重试只会留下一条完整记录。

---

## 五、禁止事项

- 不要改评分刻度、不要省字段、不要用自己的一套评分标准替代 `instruction`。
- 不要在 `kind=review` 的任务里带点评或改写——只给四个分数。
- 不要用四个分数冒充完整批改，也不要为了凑字段编造点评。
- 不要写 `~/.ielts/writing/submissions/`。
- 不要删 `pending/`。
- 不要直接覆盖 `done/<id>.json`（先写 `.tmp` 再改名）。
- 不要用上一篇的结论影响下一篇。多篇任务逐篇独立评。
- 不要在同一个对话里做复核——模型看得见自己上一次的结论，那就不算独立评分。
- 不要在没有 `instruction` 的情况下评分——如果文件里没有这个字段，说明任务格式不对，直接报告。

---

## 六、人类维护部分

### 这套东西怎么起来的

```bash
cd "C:\Users\cy\Desktop\else项目\网站破甲\writing-coach"
npm start            # 前端 5273，后端 4100
```

浏览器开 http://localhost:5273 → 填题目和作文 → 点「加入批改队列」→ 对 agent 说「开始」→ 网页每 2 秒查一次，结果到了自动跳转。

单进程模式：`npx vite build && node server.js`，直接开 http://127.0.0.1:4100 。

### 换 agent 怎么接

两条路，选一条：

**A. 装 Skill（省得每次粘提示词）**
把 `SKILL.md` 复制到那个 agent 的技能目录：

```
C:\Users\cy\.workbuddy\skills\writing-coach-grader\SKILL.md     ← WorkBuddy 已经装好
<对方 agent 的 skills 目录>\writing-coach-grader\SKILL.md        ← 换 agent 时复制到这里
```

**B. 不装 Skill**
把这份 `AGENT.md` 整个喂给那个 agent 当上下文，之后说「开始」就行。

### 用哪个 agent

同一个时刻**只能有一个** agent 处理队列。两个同时跑会各自写同一个 `done/<id>.json`，后写的覆盖前面的，等于白跑一遍。

Task 1 需要能读图的多模态能力。纯文本 agent 处理 Task 1 时，指令会要求它明确说「未读取到配图」而不是编数据——结果是评分不可用，但不会污染数据。

分数宽严完全看那个 agent 的模型。指令里的校准表和卡分清单是唯一的质量闸门，没有二次校验。

### 排错

| 现象 | 查这里 |
|---|---|
| 网页一直转圈 | `pending/` 里还有没有文件；有就是 agent 没跑，没有了就是卡在 ingest |
| 网页显示「这次没有批成」+ 原因 | 看 `failed/<id>.json` 的 `reason`，通常是缺维度、缺点评、分数不是半步进、evidence 全对不上。改好 done 文件后点「重新检查结果」 |
| 页面显示「结果文件还在写入」 | normal，AI 正在写 done，等几秒；一直这样说明 agent 卡住了 |
| 刷新后找不到任务 | 侧栏「等待中的任务」，点一下回到等待页；任务文件还在 `pending/` |
| agent 说找不到队列 | 路径对不对，`C:\Users\cy\.ielts\writing\queue\pending` 存不存在 |
| 任务跑完但网页没反应 | `done/` 里有没有 `<id>.json`；文件名要和 `id` 完全一致；内容是合法 JSON 对象 |
| 提示「结果无法解析」 | 这份结果被拒收了，看页面上的具体原因；四个分数没有点评的会被当复核结果拒收 |
| 提示「来源不被允许」（403） | 浏览器地址不在 CORS 白名单里，或 Host 头不是本机。用 localhost / 127.0.0.1；换端口正常，换机器地址要用 `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` 配 |
| 提示「Host 不被允许」 | 同上，Host 这一层就拒了。本地默认只认 localhost / 127.0.0.1 / [::1] |
| 提示「不接受 imagePath 参数」 | 图片只能用 `imageBase64` 上传，服务端不接受客户端指定本地文件路径 |
| 对话/改写提示要切模式 | 队列模式不走模型直连，右上角设置切到「自己的 API」 |
| 分数明显偏高 | 换更强的模型重跑；本地实测 Llama 类会把弱作文评到 7 分 |
| 队列积压 | `GET /api/queue` 会给超过 24 小时的标记，网页上也能看到 |

### 改完代码怎么验

```bash
npm test                    # 110 个用例，临时目录，不碰真实数据
node scripts/verify-ui.mjs  # 真浏览器跑一遍主流程
npm run check               # 检查 submissions/ 是否仍满足老看板 schema
```

### 目录速查

| 路径 | 是什么 |
|---|---|
| `C:\Users\cy\Desktop\else项目\网站破甲\writing-coach` | 项目根 |
| `~\.ielts\writing\queue\` | 队列（pending / done / failed / claims / imported / attachments） |
| `~\.ielts\writing\submissions\` | 契约文件，老看板 `ielts-dashboard` 只读这里 |
| `~\.ielts\writing\assessments\<id>\` | 单篇的完整数据（原稿、改写、逐维点评、对话） |
| `writing-coach\config.local.json` | 模式与接口配置（已 gitignore，不含 key） |
| `writing-coach\README.md` | 项目本身的开发文档 |

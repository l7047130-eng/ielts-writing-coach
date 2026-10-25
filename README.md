# writing-coach

本地自用的雅思 Task 1 / Task 2 作文批改。无登录、无计费、无额度限制。

默认不消耗任何 API token：作文提交后写成本地任务文件，你在 WorkBuddy 里跑一次队列就出结果。也可以切回直连模式填自己的 key。

结果写进 `~/.ielts/writing/submissions/`，你现有的 `ielts-dashboard` 打开就能看到——分数趋势、四维雷达、高频错误 Top 10 会自动更新。

## 快速开始

```bash
npm install
npm start
```

浏览器打开 http://localhost:5273 。默认就是队列模式，不需要配任何东西。

单进程跑（不用 vite 热更新）：

```bash
npx vite build
node server.js          # http://127.0.0.1:4100
```

## 两种模式

设置里（右上角齿轮）切。

| | 文件队列（默认） | 自己的 API |
|---|---|---|
| 消耗 | 你的 WorkBuddy 额度 | 你自己的 API token |
| 操作 | 提交后在 WorkBuddy 跑一次队列 | 全自动 |
| 图片 | 图片存本地，AI 从文件读 | 直接发给多模态模型 |
| 双评 | 单评（可在结果页发起复核） | 两次独立评分 + 一致性检测 |
| 追问 / 重新生成改写 | **不可用**（会明确提示切模式） | 可用 |

队列模式不碰模型接口，所以「对话」和「重新生成改写」这两个按钮在队列模式下会直接告诉你需要切到 API 模式，不会静默发请求。

## 队列模式怎么用

> 给 AI 的完整操作手册在 **[`AGENT.md`](./AGENT.md)**。把那份文档交给任意一个能读写本地文件的 agent，它看到「开始」两个字就自动接手整个流程。

```
Compose 填题目 + 作文 → 点「加入批改队列」
  ↓
任务写成 ~/.ielts/writing/queue/pending/<id>.json
（题目、作文、图片路径、完整评分规则都在这个文件里）
  ↓
在 WorkBuddy 里说「批改队列」，或敲 /grade
  ↓
AI 读任务 → 按文件里的 instruction 评分 → 把结果写到 done/<id>.json
  ↓
网页每 2 秒查一次，看到合法结果自动落盘并跳到结果页
```

关键点：**评分规则跟着任务走，不在 Skill 里**。每个待处理文件自带完整的评分指令、JSON schema、错误标签枚举。以后改提示词，AI 那边什么都不用动。

### 目录结构

```
~/.ielts/writing/queue/
├─ pending/<id>.json     网站写，AI 读（含 instruction 和 output_path）
├─ done/<id>.json        AI 写，网站读
├─ failed/<id>.json      校验不通过时留下原因（含失败时那份 done 的指纹）
├─ claims/<id>.json      ID 占位，入队/开批前原子创建，防止同名覆盖
├─ imported/<id>.json    已导入标记，让重复 ingest 幂等返回
└─ attachments/          Task 1 的题目图
```

### 任务怎么恢复

- 提交后刷新/关掉页面，侧栏顶部会出现「等待中的任务」，点一下回到等待页
- 等待页的「稍后再弄」只是离开，任务还在磁盘上；「取消任务」才会删文件
- 结果已经落盘但页面还没跳转时，任务会显示成「有结果」，点进去直接导入

### 触发方式

**装了 Skill**：`/grade`，或直接说「批改队列」。
Skill 在 `~/.workbuddy/skills/writing-coach-grader/SKILL.md`，作用只是「扫 pending → 照 instruction 做 → 写 output_path」，不含任何评分逻辑。

**没装 Skill**：粘一句固定的短提示词（等待页上有复制按钮）：

```
跑一下写作批改队列：读 ~/.ielts/writing/queue/pending/ 下的每个 json，
按文件里 instruction 字段的要求完成批改，结果写到该文件 output_path 指定的位置。
```

### 不想让 AI 跑队列时

等待页有「已经拿到回复了？直接粘进来」——把任意来源的批改 JSON 粘进去也能解析落盘。解析器兼容：信封结构 `{passA, passB, revision}`、围栏包裹、前后夹解释文字。**但内容必须合规**：四个 0.5 步进的分数 + 四维点评，否则会被拒收并告诉你缺什么。

## 结果校验

AI 写的东西不一定是合规 JSON，所以落盘前有三道关：

1. **分数契约**：四维分数必须是有限数值、0–9、0.5 的整数倍。`6.3`、`80/100`、`-6`、空字符串、越界值一律拒绝——以前这些会被猜成 6.3 / 9 / 6 / 0，等于把错误输出当成绩。数字字符串只接受严格写法（`"6.5"` 可以，`"6.5（Band 6.5）"` 不行）。
2. **完整批改 vs 仅分数复核**：完整批改必须同时有四个分数和四维点评；只有四个分数、没有任何点评的对象属于「复核结果」，**不能**当完整批改落盘。两条路径用两套契约分别校验。
3. **改写稿体检 + 防粘错**：改写稿与原文完全相同、词数偏离原文 0.6–1.6 倍、或本身是 JSON 的，一律丢弃并给 warning；把点评里引用的 `evidence` 和当前作文做归一化比对，全部对不上就拒绝落盘、移进 `failed/`——挡住「粘了上一篇的回复」。

失败一律不写 `submissions/`（坏记录比没记录更糟）：`failed/<id>.json` 里记原因，页面上直接显示。改好 done 文件后点「重新检查结果」就能重试；失败标记会记住「判失败时那份文件长什么样」和「任务文件长什么样」，你换了任何一个它就重新放行。

### 落盘是原子的：校验在前，发布在后

「先写成绩、再校验图片」出过一次事：图片被拒了，正式成绩却已经进了老看板，而记录目录只有 `original.md`、没有 `meta.json`（详情接口 404），一次失败留下两处不一致。

现在的顺序是三步，任何一步失败都不会留下痕迹：

1. **准备（只读）**：分数合法性、`passes.a`、正文非空、图片的**来源目录 / 类型 / 存在性 / 是否文件 / 可读性**、以及老看板 schema，全部在这里查完。查不过直接抛，磁盘上一个字节都不写。
2. **暂存**：整套文件（原文、评分、合并结果、改写、图片、meta）先写进 `assessments/.staging/<id>-<随机>/`。更新已有记录时，会先把旧的 `chat.jsonl`、`revised.md`、`image.*` 复制进来，所以复核不会弄丢对话和改写。`meta.json` 最后写，它是「这个目录完整」的标记。
3. **发布**：旧目录改名为备份 → 新目录换上去 → 原子写 `submissions/<id>.md`。成功后删备份。

**两种失败，必须分清楚：**

| 情况 | 错误码 | 磁盘状态 | 提示 |
|---|---|---|---|
| 发布失败，回滚成功 | `EPERSIST_PUBLISH` | 与操作前完全一致 | 「已回滚，正式记录未改动」 |
| 发布失败，回滚也失败 | `EPERSIST_ROLLBACK_FAILED` | 原位置可能暂时没有记录，完整数据在备份里 | 「回滚失败」+ 备份绝对路径 + 恢复步骤 + 失败明细 |

第二种情况**不会**再谎称已回滚。响应体里带 `recovery: { backupPath, targetPath, failures, restoreHint }`，`failed/<id>.json` 的 warnings 里也会列出备份位置。人工恢复就一步：停掉写入，把 `backupPath` 改名为 `targetPath`，详情页立刻可读。

### 恢复备份与临时垃圾分开管理

- `assessments/.staging/`：只放还没发布成功的半成品，超过 1 小时自动清。
- `assessments/.recovery/`：只放发布过程中的备份。**没有「已确认不再需要」标记的备份永远不会被自动删除**——它可能是那条记录唯一完整的一份。
- 发布成功后备份确实没用了：删除成功即消失；删不掉就在旁边写一个 `<备份>.resolved` 标记，只有带标记且超过 1 小时的才会被清理。
- 想看当前有哪些备份待处理：`listRecoveryBackups()`（`lib/persist.js` 导出）会列出 id、路径、时间和是否已标记解决。两个目录都是点开头，`listAssessments` 会跳过，不会被当成记录。

失败时队列状态会变成 `failed`（不会继续报 done），`pending/` 保留，修好图片或结果后直接重试即可；重试成功只会有一条完整记录。

## 单评，不假装双评

队列模式默认**单评**。同一个上下文里让模型「先评一次再独立重判」是假信号：第一轮的点评里已经写了「不是 7 档因为…」，模型无法真正无视。那样产出的 `spread` 恒为 0、`boundary` 恒为 false，看板的「边界样本」维度会永久失效。

所以单评时 `pass_overall` 只有一个元素、`spread` 是 `null`，结果页显示「单评 · 未做一致性检测」。API 模式跑两次独立调用，综合分按「四维先取未舍入平均，再算总分，全程只 round 一次」计算。

想要真正的一致性检测，有两种办法：
- 切到 API 模式（两次独立调用，上下文天然隔离）
- 在结果页点「发起复核」，把只含四个分数的短任务再入队一次，**在新对话里跑**

复核用的是**服务端存的那份原文、题目、配图和用时**，不接受客户端重新提交的材料；合并时保留完整批改的点评，不会因为复核给的分数更高就换成空点评。

## 数据从哪来、存在哪

### 这套数据根不是本项目的

`~/.ielts/` 这个目录和里面的划分，来自另一套雅思教练项目（作者 **yan**，在小红书和 B 站都有分享）。
那套项目覆盖听说读写词汇多个模块，`~/.ielts/` 下能看到它的全貌：

```
~/.ielts/
├─ profile.md       个人目标与背景
├─ scores.md        历次成绩汇总
├─ scoring.md       评分标准摘录
├─ progress/        学习进度
├─ vocab/           词汇
├─ listening/  reading/  speaking/  audio/
├─ exams/           真题
└─ writing/         ← 本项目只读写这里
```

本项目**只负责 `writing/` 这一块**，其他目录一律不碰。

共用一个数据根是有意的：那套项目里的 `ielts-dashboard` 直接读 `writing/submissions/`，
按 `writingSubmissionSchema` 展示分数趋势、四维雷达和高频错误。批改结果按同一份契约落盘，
打开看板就能看到新记录，不需要导入或迁移——这也是为什么 `npm run check` 要校验 schema，
校验不过的文件会被看板静默跳过。

### 不装那套项目也能单独用

本项目不依赖它的任何代码。`~/.ielts/writing/` 只是一组约定好的文件路径，
目录不存在时首次写入会自动创建（`ensureDirs()` 走 `mkdirSync(recursive: true)`）。

数据根可以用环境变量改：

```bash
IELTS_HOME=D:/ielts-data npm start    # 默认是 ~/.ielts
```

代价是没有看板，结果得自己打开 `submissions/` 下的 md 文件看。

### 隐私

- **全部本地**：不登录、不上传、不向第三方传输任何内容。
- **模型调用可选**：队列模式完全不联网，只写本地任务文件；直连模式只把当次作文发给你自己配置的 API 端点。
- **仓库里没有数据**：`~/.ielts/` 在用户目录下，不在项目目录内；`config.local.json`（存 API key）已被 `.gitignore` 排除。
  clone 这个仓库拿到的是代码，不含任何人的作文。
- Task 1 的题干截图跟着记录走，存在 `assessments/<id>/image.jpg`，同样只在本地。

## 落盘位置

```
~/.ielts/writing/
├─ submissions/
│  └─ 20261024_task2_ageing-population.md    # 契约文件，老看板只读这里
└─ assessments/
   ├─ 20261024_task2_ageing-population/
   │  ├─ meta.json      # 列表页、分数、spread、source、review_count
   │  ├─ original.md
   │  ├─ revised.md
   │  ├─ merged.json    # 合并后的评分与点评（含未舍入的 raw 均值）
   │  ├─ passes.json    # 原始评分（a / b）
   │  ├─ chat.jsonl     # 追问对话
   │  └─ image.jpg      # Task 1 的题目图
   ├─ .staging/         # 尚未发布的半成品，超 1 小时自动清
   └─ .recovery/        # 发布过程的备份，未标记解决前不会自动清
```

`submissions/` 的 frontmatter 严格满足 `ielts-dashboard/lib/schema.js` 的 `writingSubmissionSchema`。改动前先跑：

```bash
npm run check
```

校验不过的文件会被老看板的 scanner **静默跳过**，用户会以为记录丢了。

## ID 与并发

- **中文 / 中英混合话题照常生成 ID**（`20261024_task2_公共图书馆`），旧版本生成的中文 ID 也照常可读、可展示、可复核，不需要迁移。校验规则统一为「字母（含中文）数字开头，之后允许字母数字下划线点短横线」，继续拒绝路径分隔符、`..`、绝对路径、控制字符、Windows 保留名（CON / AUX / NUL / COM1…）。
- 任务 ID 是「先原子占位，再写文件」：`openSync(claims/<id>.json, 'wx')` 在 OS 层抢锁，抢不到就换下一个序号。
- **占位成功后还会再核对一遍**其它存储位（submissions / assessments / pending / done / failed / imported）。只靠 wx 有一个交接窗口：B 检查完未占用 → A 抢到、落盘、撤占位 → B 的 openSync 反而成功，拿到 A 已经用掉的号。占位后复核补上了这一段。
- 占位文件带随机 token，释放时只认自己创建的那一份；延迟的 `settleClaim` / `releaseClaim` 不会误删别人接手后的占位。
- ingest 是幂等的：同一个任务被两个页面同时轮询，只有一次真正落盘，另一次拿到已导入的那条记录。

## 测试

```bash
npm test                    # 110 个回归用例，全部在临时 IELTS_HOME 上跑
node scripts/verify-ui.mjs  # 浏览器端验证，真 Chromium，假数据，截图写到 review-artifacts/
```

- 测试不读 `~/.ielts`，不调用真实模型，不依赖任何个人路径
- `verify-ui.mjs` 覆盖：提交 → 等待 → 刷新恢复 → 不合格结果失败提示 → 修正后重试 → 成功结果 → 发起复核
- 占位交接竞态用**确定性进程同步屏障**复现（B 检查完 → A 落盘并释放 → B 占位），不是靠多跑几次碰运气
- Host 伪造用**原生 TCP 请求**验证，不依赖 fetch 对 Host 头的处理
- 老的 `scripts/smoke.js`、`e2e.js`、`regress-api.js`、`calibrate.js` 会读写真实数据，别在没确认的情况下跑

### 结论的适用范围

- **旧数据兼容**：已验证现有的 5 份正式记录与抽样构造的中文 ID 记录可正常读取、展示、复核，落盘文件仍满足老看板 schema。不能由此推出「任何历史数据都兼容」——覆盖不到的形态（异常文件名、半截 meta）仍可能被列表跳过。
- **ID 不撞号**：已验证同进程并发、两个真实 Node 进程的交错交接、占位释放后的复核。不能推出「任何并发模型下绝不撞号」——比如网络文件系统上的锁语义、跨机器共享同一数据目录，都不在验证范围内。
- **评分准确性**：本轮所有测试用的是本地模拟接口，只验证流程与契约。**不构成对评分准确度的任何证明**，也没有依据说真实模型「固定宽松 0.5 分」。在没有可靠人工评分样本之前，不做统一扣 0.5 分之类的校准。

## 错误标签

15 个 tag 与 `src/labels.js` 对齐，且每个 tag 固定归属一个 type（`TAG_TYPE` 表，归一化时强制改写）。这样老看板的「高频错误 Top 10」才有统计意义。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 当前模式、还缺哪几项 |
| GET/PUT | `/api/settings` | 读/写配置（key 打码；传空表示不修改） |
| POST | `/api/settings/test` | 测文本 + 视觉通路（请求通 / 能力验证通分开报） |
| POST | `/api/settings/models` | 拉模型列表 |
| POST | `/api/queue` | 入队，返回 id + 触发提示词；body 带 `{kind:'review', id}` 时发起复核 |
| GET | `/api/queue` | 待处理列表（含 `state` / `has_result` / 24h 积压标记） |
| GET | `/api/queue/:id` | 任务状态：`pending`(可带 `resultState: writing`) / `done` / `failed`(带 `failure`) / `imported` / `missing` |
| DELETE | `/api/queue/:id` | 取消并清理 |
| POST | `/api/queue/:id/ingest` | 读 done 落盘；body 带 `reply` 时改为解析粘贴的文本。幂等 |
| POST | `/api/grade` | SSE，直连模式批改 |
| POST | `/api/assessments/:id/revise` | SSE，重生成改写（仅 API 模式，队列模式 409） |
| POST | `/api/assessments/:id/chat` | SSE，追问对话（仅 API 模式，队列模式 409） |
| GET | `/api/assessments` `/api/assessments/:id` | 列表 / 详情 |
| DELETE | `/api/assessments/:id` | 删除（连带契约文件） |

SSE 的错误分三种，前端分别处理：HTTP 非 2xx（凭据/模型名问题）、`event: error`（模型返回 400 之类业务错误，`done` 里带 `ok:false`）、连接断了但没收到 `done`。

## 跨域与 Host

两层都要过：

1. **Host 必须属于配置允许的服务地址**。默认 `localhost` / `127.0.0.1` / `[::1]`，换 PORT 不受影响。其它部署地址（局域网 IP、内网域名）用 `ALLOWED_HOSTS=192.168.1.9,intranet.local` 显式配置。Host 不可信直接 403，连 `curl` 也一样——挡的是伪造 Host 和 DNS rebinding。
2. **Origin 走精确白名单**：默认 `localhost` / `127.0.0.1` 上的 5273、5173、4100，加上「可信 Host 的同源」（页面自己加载自己的模块脚本，换 PORT 后就是这个形态）。别的来源一律 403，不做静默降级。

只把 Host 和 Origin 都伪造成自己是过不去的：同源放行只对受信任 Host 成立。要用别的来源：`ALLOWED_ORIGINS=http://192.168.1.9:4100 node server.js`（逗号分隔，写完整 origin）。

## 图片来源

- 前端上传只走 `imageBase64`（`data:image/...`），**不接受 `imagePath` 参数**——那是服务端生成的附件路径，放进来等于让任意本地文件被读进数据目录。
- 复制进评估目录前会同时校验**来源目录、目标目录、图片类型**：队列附件只能从 `queue/attachments/` 复制，复核存档图只认该记录自己的评估目录，扩展名只允许 jpg / jpeg / png / webp / gif。
- Task 1 的复核沿用原图，不再复制一次。

## 已知未做

- 失败记录不能手工补分，只能改 done 文件 / 重贴一次，或删了重批
- Task 1 在队列模式下依赖 AI 能读到本地图片；图糊或信息密集时可能读漏数据
- 改写对照按段落配对，不是逐句 jsdiff
- 打包体积约 640 KB（recharts 占大头），没做代码分割
- 界面按桌面宽度设计，窄屏没适配

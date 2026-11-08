# English Reader

一个以文章为入口的 AI 英语阅读插件，作为 DeepSeek Harness 的原生 bundle 运行：自动发现 / URL 导入 / 手动粘贴 → 正文清洗与去重 → 分阶段 AI 解析（导读、难度、单词、短语、搭配、切分、逐句、复盘）→ 连续阅读与双栏精读 → 跨文章复用的个人知识库与复习队列。

所有数据本地优先：SQLite（`node:sqlite`）+ 每篇文章的正文文件。模型调用经 Harness 的 `llm` 运行时，插件不读取任何 API Key。

## 安装

```bash
# 在 dsh 会话中
plugin_manager  install_bundle   target: /absolute/path/to/english-reader
```

或在插件管理界面里安装目录。安装后侧栏出现 `English Reader` 图标，点击进入主面板。

## 配置（`cordis.patch.yml`）

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/english-reader` | 数据库与文章正文目录；留空用默认 |
| `sentenceConcurrency` | `2` | 逐句解析并发（1–5） |
| `retryLimit` | `2` | 单个阶段最大尝试次数 |
| `wordsPerArticle` | `15` | 每篇提取的重点词数 |

## 界面

| 页面 | 说明 |
|---|---|
| 首页 | 学习统计、最近阅读、解析任务队列（失败可单阶段重试） |
| 采集文章 | 两级页签：**采集规格**（自动发现 / URL 导入 / 手动粘贴）与**发现内容**（候选列表，滚到底自动加载下一页）。规格含难度区间 / 21 个来源 / 发布时间 / 12 种类型 / 敏感内容 / 词数 |
| 我的文章 | 搜索与筛选（难度、状态、来源），解析、阅读、导出、删除。列表撑满一屏，内部滚动 |
| 文章详情 | 双栏精读（左原文右解析）与连续阅读；句子联动、单词弹窗、笔记、解析进度 |
| 知识库 | 单词 / 短语 / 搭配 / 句子四个库，收藏、掌握程度、来源语境 |
| 复习中心 | 未掌握单词的卡片式复习 |
| 设置 | 模型（按 Harness 分组，显示会话实际使用的模型）、解析参数、发音（音色 / 语速 / 试听 / 缓存）、数据目录与备份说明 |

## Agent 工具

| 工具 | 用途 |
|---|---|
| `english_reader_search` | 搜索文章或任一知识库集合 |
| `english_reader_import` | 按 URL 或正文导入，可选立即解析 |
| `english_reader_analyze` | 启动 / 查询 / 重试单个阶段 / 取消解析 |
| `english_reader_knowledge` | 收藏、设置掌握程度、写笔记 |
| `english_reader_speak` | 用 Edge 神经语音朗读单词 / 短语 / 整句（返回 MP3 附件） |

UI 与工具调用同一个 facade，行为一致。

## 视觉：Bento Grid 2.0

界面按 [Bento Grid 2.0 规范](docs/bento-grid-2.0.md) 排版：12 列 board，单元格按内容价值取 span（12 / 8 / 6 / 4 / 3），全board 只有一个 gap 值，圆角随面积增大（18 / 24 / 28px），阴影最多两层（1px 接触 + 一层大范围环境光）。

规范里的数值有出处：圆角与栅格实测自 Framer 的 bento 区块（`repeat(3, minmax(50px,1fr))`、`gap: 40px 20px`、圆角 15/18/25px 集中分布）与 Apple 商店卡片（10/12/15/18px + 细描边）的线上 CSS。文档按 **[measured] / [derived] / [constraint]** 标注每条规则的来源——这不是某个官方标准，而是从实现中提取的工作规范。

`tests/bento.mjs`（41 项）把规范变成断言：span 只能来自表内、board 只能有一个 gap、圆角按面积递增、阴影层数 ≤ 2、暗色必须有对应变量、900px 下塌成 2 列。

## 学习记录（贡献图）

左侧「学习记录」页用 GitHub 风格热力图展示**最近一年**的真实学习情况：7 行 × 53 列，颜色深浅按当天学习时长分四档。

首页嵌的是**同一个组件**（不是另写的版本）：同一份一年期热力图、同样的统计行，只是多一个「查看全部」链接跳转到完整页面。

统计依据是**真实记录的学习事件**（保存阅读进度、复习单词、加入知识库），不是文章预估阅读时长——后者只是「收藏了多少」，不能证明那天学过。若某次保存没带实测时长，会记一次事件但时长记 0，不猜。

同时显示当前连续天数、最长连续、累计时长、学习天数，以及时间在阅读/单词/短语/搭配间的分布。

## 知识库是手动加入的

解析文章只产生**候选**（词汇、短语、搭配、句子）。这些候选**不会**自动进入知识库——知识库列表里只有你主动点过「加入知识库」的条目。

加入入口在阅读页，四处都有：

| 位置 | 控件 |
|---|---|
| 重点单词 tab | 每张单词卡右上角 |
| 短语 tab | 每行右侧 |
| 搭配 tab | 每行右侧 |
| 逐句解析面板 | 句子上方 |

未加入显示 `+ 加入知识库`，已加入显示 `✓ 已在知识库`，再次点击即可移出。复习中心也只覆盖已加入的词汇。

## 采集规格与来源策略

采集结果会**持久化**：切换页面再回来，未导入的候选仍在列表里（数据存于 `discovered_articles` 表）。采集过程有**实时进度**：总进度条、每个来源的状态徽标、以及逐条日志（最新在前）。

候选列表**分页读取**：一屏放得下，滚到底自动拉下一页并追加，不会一次把全表拉出来。勾选后「导入所选」逐条处理：成功的移入「我的文章」并从发现列表消失，失败的留在原位并标出原因（如正文抓不到、篇幅不合），可重试。

采集规格共七项：**采集文章数量（默认 1）**、CEFR 区间（默认 B1–B2）、来源多选（默认全选 21 个）、发布时间（24 小时 / 7 天 / 30 天 / 自定义，默认 7 天）、文章类型（12 种，默认全选）、敏感内容过滤（默认开）、**词数（默认不限制）**。

词数有两种模式：**不限制**（默认，不看篇幅）或**可选范围**。选范围后，输入框右侧有一个「允许截断文章」开关（**默认开启**）——关掉则超长文章直接跳过；开启则按句截断，只落在句子边界，不会把句子切成两半。数量决定一次采集最终保留的候选数，来源多时按匹配度取前 N 篇。

**每个来源一套抓取策略**，定义在 `lib/sources.js` 的注册表里：

| kind | 用于 | 行为 |
|---|---|---|
| `feed` | 有 RSS/Atom 的媒体（16 个） | 解析 feed 取标题/链接/日期/摘要 |
| `html` | 只有列表页的站点（CNN 10、BBC Learning English、Engoo、Arts & Letters Daily） | 抓列表页链接 |
| `catalog` | Project Gutenberg | 浏览目录 |

策略还负责该站的**难度带**、**可产出类型**与**特有后处理**（如 News in Levels 的 `level-3`、Gutenberg 的许可证围栏）。**新增来源只需往注册表追加一行**，必要时加一个 extractor 函数，不必改采集流程。

每次采集会逐源返回结果：成功条数 / 错误码 / 被敏感词过滤数 / 整源跳过原因；失败的来源会在表单里标 ⚠，并记住上次的失败原因。**不会把抓取失败说成「没有文章」。**

## 解析失败怎么看原因

文章详情页顶部会出现「失败原因汇总」卡片，列出失败句子、错误码与解释；点「定位」跳到那句，句子卡片里还能：

- 看错误码与中文解释（截断、JSON 不合法、模型不可用、结构不符、引用找不到…）
- 展开**模型原始输出**（开头 + 出错位置附近，便于直接判断是截断还是夹带说明）
- **重试这一句**，不影响其他已成功的结果

阶段条上的计数只描述**已完成的工作**：`切分 15/15` 表示切成 15 句，`逐句 15/15` 表示 15 句都已出结果（含标注了不确定性的）。「待复核」只在**引用的原文片段找不到**时出现——模型主动说明「这里有两种理解」不算待复核，属正常分析。

错误码：`LLM_TRUNCATED`（输出被截断）、`LLM_INVALID_JSON`（JSON 不合法）、`LLM_UNAVAILABLE`、`LLM_TIMEOUT`、`SCHEMA_VALIDATION_FAILED`、`EVIDENCE_NOT_FOUND`。

## 抓取与网络

抓取优先走 Harness 自己的网络通道（`ctx.web.fetch()`）：它认识部署的 fake-IP 段，所以站在代理后面的环境里也能拿到页面；插件自带的抓取器留作兜底，并自带 SSRF 防护（拒绝内网、回环与云元数据地址，仅放行部署显式声明的合成段）。

> 若目标站正文很长，注意 Harness 抓取 provider 的 `maxBodyChars` 默认 100000 字符——页面框架就可能超限，正文会被截断。`cordis.patch.yml` 里调大它即可：
> ```yaml
> - id: web-fetch-http
>   name: "@deepseek-ai/dsh-web-fetch-http"
>   config:
>     maxBodyChars: 3000000
>     maxResponseBytes: 6000000
> ```

## 数据与备份

数据分三处：SQLite（`node:sqlite`，元数据 / 解析 / 词汇 / 进度）、`<dataDir>/articles/<id>/cleaned.md`（正文）、`<dataDir>/cache/speech/`（音频缓存）。备份就是**整个 `<dataDir>` 目录**拷走；恢复时放回同一路径再启动 Harness 即可。设置页「数据目录与备份」里列出了需要复制的子目录。

## 发音（edge-tts）

朗读走微软 Edge 的神经语音接口，与 `edge-tts` **同一套 WebSocket 协议**，直接用 Node 内置 `WebSocket` 实现，不需要 `pip install edge-tts`、Python 或任何密钥。

- 入口：单词弹窗、逐句解析面板、句子列表、知识库详情、复习卡片、设置页试听。
- 音色：Aria（美音女声）、Guy（美音男声）、Sonia（英音女声）、Ryan（英音男声）、Natasha（澳音女声）。
- 语速 −50…+100%；音色与语速保存在浏览器本地。
- 音频按 `(音色, 语速, 文本)` 缓存在 `<dataDir>/cache/speech/`，命中即 0 延迟；设置页可一键清空。
- 单次朗读上限 1200 字符、20 秒超时；失败返回 `SPEECH_*` 错误码并由 UI 提示，不会静默失败。
- 引擎不可用（无网络 / 无 WebSocket）时设置页显示「未配置」，按钮给出错误提示。

## 开发

```bash
node scripts/build-client.mjs      # src/*.js → lib/client.js（纯 JS，无 JSX/TS）
node tests/all.mjs                 # 一次跑完所有套件
node tests/behaviour.mjs           # 文本层、网络层、去重、知识保留
node tests/user-state.mjs          # 重新解析不覆盖用户收藏/掌握/笔记/进度
node tests/bundle.mjs              # bundle 契约（id / 槽位 / 词典 / 导出）
node tests/deep-render.mjs         # 用迷你 React 渲染每个页面并点击标签
node tests/schema-check.mjs        # 按 tools registry 的真实规则校验 schema
node tests/failure-diagnostics.mjs  # 失败原因落库、截断识别、单句重试、阶段一致性
node tests/sources.mjs             # 来源注册表契约、feed/Atom 解析、列表页抓链、策略接口
node tests/bento.mjs               # Bento 规范一致性：span/gap/圆角/阴影层数/暗色/响应式
node tests/stage-counter.mjs       # 阶段计数语义（切分/逐句/其余阶段）
node tests/revalidate.mjs          # 已存分析按原文重新校验、幂等
node tests/article-count.mjs       # 采集数量默认/夹取/覆盖与客户端不硬编码
node tests/knowledge-optin.mjs     # 知识库必须手动加入：候选不自动入库、移出即删除
node tests/study-history.mjs       # 学习记录：事件记录、按天聚合、连续天数、不使用估算时长
node tests/word-limit.mjs          # 词数策略：不限制/范围、按句截断不切断句子
node tests/speech.mjs              # 语音协议、缓存、错误码（ER_SPEECH_LIVE=1 走真实网络）
node tests/speech-client.mjs       # 播放请求形状、失败提示、音色偏好
node tests/inspect-db.mjs [path]   # 只读查看线上数据库状态
```

浏览器产物是 `window.__ModuleLoader__.load({ id, factory })` 形式的单文件；`src/` 按数字前缀决定拼接顺序，构建脚本去掉各文件的 `export { … }` 让它们共享一个工厂作用域。

## 目录

```
english-reader/
├── cordis.patch.yml          # bundle 的 loader patch
├── package.json              # dsh.bundle + dsh.client
├── icon.svg                  # 插件图标（原创）
├── locale/{en,zh}.json       # 插件显示名与描述
├── lib/
│   ├── index.js              # Host 半：路由 + 工具 + 启动恢复
│   ├── facade.js             # 应用 facade（UI 与工具共用）
│   ├── store.js              # SQLite schema、迁移、正文文件
│   ├── text.js               # HTML 清洗、切句、CEFR 启发式
│   ├── net.js                # URL 安全校验、抓取、搜索适配
│   ├── llm.js                # 模型调用 + schema/证据校验 + 修复重试
│   ├── demo-library.json     # 三篇示例正文
│   └── client.js             # 构建产物（不要手改）
├── src/                      # 浏览器半的源码
├── docs/implementation-decisions.md
├── tests/
└── scripts/build-client.mjs
```

## 设计原则

1. 文章是入口，知识实体是长期资产。
2. 解析是生产过程；知识库是独立模块。
3. 原文可追溯，AI 结论必须有原文证据。
4. 模型输出不可信，必须结构校验 + 证据校验。
5. 用户修改优先于 AI 重新生成。
6. 任务可恢复，数据可备份。

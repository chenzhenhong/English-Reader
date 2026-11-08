# English Reader 实现决策记录

> 本文记录 Phase 0「Harness 能力核查」的实际结论：哪些假设成立、哪些 API 与需求书不同、适配方案是什么。
> 核查依据：`cordis_inspect_query`（Service / Event / Config / Slots / Theme / Builtin）、
> 已安装包源码 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*`、以及本机运行中的
> Web profile（`english-reader` bundle 已安装并激活）。

## 1. 插件形态

| 需求书假设 | 实际情况 | 决策 |
|---|---|---|
| `manifest.json` + 自定义插件目录 | Harness 使用 **bundle package**：`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`；Host 半为 ESM 入口，Web 半为 `dsh.client` + `./client` 导出的 `window.__ModuleLoader__.load({id, factory})` | 按 bundle 形态实现，`install_bundle` 安装 |
| 需要为 UI 起独立服务/iframe | Client 是注册进 live slot tree 的 React 组件；iframe 拿不到主题 token 与 locale | 用 `main`（keyed，key=`english-reader`）+ `sidebar.panellist`（list）两个真实 slot |
| 宿主会提供文件系统 API 用于数据目录 | 插件运行在 Host 进程内，**可**直接用 `node:fs`；但不保证 bare specifier 能解析到 `@deepseek-ai/*` | 数据层只用 Node 内建（`node:sqlite` / `node:fs`），不 import 任何 `@deepseek-ai/*` 值 |

## 2. 存储

- **SQLite**：`node:sqlite`（`DatabaseSync`）在本机 Node v26 可用，且 **FTS5 可用**（`create virtual table … using fts5` 成功，SQLite 3.54.0）。
- 需求书建议 SQLite + FTS5 + 文件系统 → 采纳；正文落 `articles/{id}/cleaned.md`，数据库存路径与 SHA-256。
- **迁移**：`schema_meta` 表存 `schema_version`；首次打开时先查 `sqlite_master`（否则 `schema_meta` 不存在会报 `no such table`），再执行幂等 `CREATE TABLE IF NOT EXISTS` 建表语句。启动不做无条件重建。
- 事务：所有多点写入走 `transact()`（`BEGIN/COMMIT/ROLLBACK`），短事务，WAL + `busy_timeout`。

## 3. 模型调用

- Harness 的模型入口是 Host `llm` service：
  `ctx.llm.stream({ provider, model, system, messages, temperature, signal })` → `AsyncIterable<StreamChunk>`；
  流以 `block-end`（`{ type:'text' }`）与 `finish` 收尾，`usage` 块带 token 数。
- 默认路由由 `agentDefaultModel.currentSelection()` 给出（本 profile 为 `trae / deepseek-v4.1-flash`）。
- **没有原生结构化输出约束**：需求书要求不假设模型严格返回 JSON → 实现为「提取首个平衡 JSON 对象 + 阶段 Schema 校验 + 证据校验 + 一次修复重试」。
- `llm` 与 `web` 都用 `ctx.get()` 可选获取：profile 没有注册搜索 Provider 时，自动发现返回 `SEARCH_PROVIDER_ERROR`，UI 提示改用 URL 导入。

## 4. 搜索与抓取

- `ctx.web.search({ query, maxResults })` 返回 `{ sources[], truncated }`，用于自动发现的候选。
- 抓取不走 `ctx.web.fetch`（它的返回形态是 `{ statusCode, body }`，且不受本插件的 SSRF 约束）；改为自建 `fetch` 适配器：仅 http/https、拒绝 localhost/私有网段/链路本地/云 metadata、**每次重定向重新校验 DNS 解析结果**、限制重定向次数/字节/超时、不发送凭证。
- 正文提取：自实现 Readability 类清洗（去 script/style/nav/footer/form，按块级标签切段，解码常见实体）。

## 5. UI 扩展点与主题

- 注册方式：`ctx.slots.inject(key, () => ctx.slots.register(options, Component))`，`inject: ['slots','locale']`。
- 面板入口：`main` slot 的 keyed 注册，`key: 'english-reader'`；侧栏图标：`sidebar.panellist`，`id: 'english-reader'`，`label: () => t('nav.home')`（thunk 随 locale 刷新）。
- 槽位 props：注册带 `locale: 'englishReader'` 时会注入 `t()`（`dsh-client-ui-renderer` 的 `localeSeat`）；组件只依赖 `React` 与 props。
- 主题：只用 `--dsw-alias-*` token 与 `--ds-font-family-code`，明暗两套都在 `body[data-ds-dark-theme]` 下重新映射；插件自有强调色以 token 派生（`color-mix`），不硬编死一个浅色主题。
- 样式：组件内渲染 `<style>` 元素（卸载即移除），不写 `document.body`、不读其它插件 DOM。

## 6. UI ↔ Host 通信

- Client 无网络能力（`fetch` 被沙箱拒绝，错误信息明确提示「network belongs to the HOST half」）。
- 为实现「UI 只调用 Application Facade」，Host 半用 `ctx.connection.fetch.register({ path:'/api/english-reader', methods:['POST'], requestBody:'buffered', fetch })` 注册**受认证保护的**同源路由；Client 用同源 `fetch` POST `{ op, args }`。
- 该路由在 Connection 的认证围栏内（非 owner Peer 直接 403），因此未额外做跨站保护；仅接受本插件自己的 operation 白名单，不接受任意 SQL/文件/URL。

## 7. Agent 工具

- `ctx.tools.register(definition)` 接收的是**原生 JSON Schema**：参数必须是 `{ type:'object', properties, required:[...] }`，输出同样是 `{ type:'object', properties, required:[...] }`。
- 只有 `defineTool()` 那条路径吃的是 DSL（字段内联 `required: true`）；因为插件不 import `@deepseek-ai/*` 值，只能走 `register(definition)`，所以 schema 一律按原生 JSON Schema 写。
- 这里踩过一次真实故障：先按 DSL 写导致线上注册被 schema 校验拒绝（工具静默消失），修正为原生 schema 后恢复。`tests/schema-check.mjs` 现在直接调用 registry 使用的 `assertSupportedJsonSchema` + `validateJsonSchemaValue`，与线上同一条校验路径。
- 注册 4 个工具：`english_reader_search` / `english_reader_import` / `english_reader_analyze` / `english_reader_knowledge`，与 UI 共用同一 facade（`user-actions.md` 的「一个操作两个调用方」）。
- 未注册任意文件读写、任意 URL 请求、任意 SQL 执行工具。

## 8. 与需求书的差异清单

| 需求 | 差异 | 适配 |
|---|---|---|
| 22 张表全量 | 首版建 20 张核心表 + `discovered_articles` / `reading_notes` / `llm_call_logs` / `app_settings`；`analysis_overrides` 已建表但 UI 暂只读，写入路径留待后续 | V1 覆盖 12.4 全部验收项 |
| FTS5 搜索 | 已确认可用，但首版知识库检索用 `LIKE` + 索引列（数据量 < 万级），FTS5 作为可插拔升级点保留 | 需求书允许「提供 LIKE 降级实现」 |
| 逐句解析并发 3 | `Config.sentenceConcurrency` 默认 2，可配 1–5 | 与需求书区间一致 |
| 自动发现「AI 难度评估」 | 候选阶段用可解释分项打分 + profile 难度带，不做每候选一次模型调用（成本/延迟） | 导入后 DIFFICULTY 阶段给出 AI CEFR 估计 |
| UI 视觉 | 需求书「简洁现代偏 Apple」，设计图为**轻拟物**（软阴影、渐变、圆角卡片） | 以实现为准，token 之上叠一层 soft-skeuomorphic 表面 |

## 9. 语音合成（edge-tts）

| 方案 | 结论 | 决策 |
|---|---|---|
| `pip install edge-tts` + Python 子进程 | 本机 Python 3.14 无 pip，且引入外部依赖与进程管理 | **不采用** |
| 浏览器 `speechSynthesis` | 音色取决于系统，Linux 上常常无声或质量很差 | 仅作为失败后的退路，不作主路径 |
| Edge WebSocket 协议，Node 内置 `WebSocket` | 本机可用：首次合成 ~1.9s / 19KB MP3，缓存命中 0ms | **采用** |

实现要点：

- 握手需要 `Sec-MS-GEC`（时间片 + 固定客户端 token 的 SHA-256）与 Edge 的 UA/Origin 头；实现与 `edge-tts` 一致。
- 二进制帧的分隔是 **单个 CRLF**（`Path:audio\r\n<MP3>`），不是 `\r\n\r\n`；最初按空行解析导致「返回无音频」，已修正。
- 文本经 SSML 转义；单次上限 1200 字符、20 秒超时、可取消。
- 缓存落盘（`cache/speech/*.mp3`），按 `(voice, rate, text)` 定键；旧文件不自动清理，设置页提供清空。
- 不读任何密钥；Edge 的公共 token 写死在协议常量里，属于公开客户端参数而非用户凭证。

## 10. 逐句失败的可诊断性

线上第一次真实解析出现「1 句失败」，但当时界面上只显示「失败」，无从判断原因。复盘后确认这是可修复的设计缺陷，不是模型偶发问题：

- **没有保存失败原因**：句子失败只写 `analysis_status='failed'`，错误码只进了 Host 日志。
- **错误码被压平**：所有句子失败都汇总为 `LLM_UNAVAILABLE`，即使真实原因是 JSON 不合法。
- **`extractJson` 会误判**：用 `lastIndexOf('}')` 找对象结尾，模型在正确 JSON 后追加一句说明时，会把说明吞进候选串，导致合法答案被判为 `LLM_INVALID_JSON`。这正是线上那句话的真实原因（`Unexpected non-whitespace character after JSON at position 2266`）。
- **截断未单独识别**：达到 `max-tokens` 时输出被切断，却被并入 JSON 解析失败。
- **片段截断在错误点之前**：只存前 2000 字符，而错误发生在第 2266 字符，等于把证据裁掉。

修复：

| 问题 | 修复 |
|---|---|
| 原因未落库 | `article_sentences` 增加 `error_code / error_message / raw_output / attempts`（schema v2，可重入迁移） |
| 码被压平 | 新增 `LLM_TRUNCATED`；阶段汇总取占比最高的真实错误码 |
| JSON 对象边界 | 改为括号配对扫描（识别字符串与转义），容忍尾随说明与第二个片段 |
| 证据不可见 | 原始输出改为「开头 + 出错位置附近」窗口，不再只留前缀 |
| 无法单句重试 | 新增 `retrySentence`（UI 卡片 + 工具 `sentenceIndex` 参数） |
| 阶段状态与事实不符 | 抽出 `refreshSentenceStage()`，重试或整批结束后按实际句子行重算 |

旧数据没有错误码，界面显示 `NO_RECORD`（「旧版本失败，未记录原因，可重试」），不编造原因。

验证：`tests/failure-diagnostics.mjs` 25 项，覆盖截断、尾随说明、第二个 JSON 片段、字符串内的花括号、转义引号、单句重试与阶段一致性。

## 11. 阶段进度与「待复核」的语义修正

用户截图暴露了一处自相矛盾：`切分` 显示「已完成 0/15」、`逐句` 显示「已完成 4/15」，但两句都标「已完成」。

两个独立缺陷：

1. **计数器读了错误的字段**。阶段条统一用 `progress.done`：
   - `切分` 的负载只有 `{ sentences: 15 }`，没有 `done`，于是渲染成 `0/15`；
   - `逐句` 的 `done` 只统计**成功**句子，于是 11 句已解析但被标待复核的句子被算作未完成 → `4/15`。
2. **「待复核」判定错误**。当时 `needsReview = 证据缺失 || 模型主动声明 uncertaintyNotes`。而这 11 句的引用**全部能在原文中找到**，它们只是模型诚实地写下了 `can` 这类词的两种合理解释。把「诚实说明不确定」当成「需要人工核对」，是归类错误。

修复：

| 问题 | 修复 |
|---|---|
| 切分计数为 0 | 抽出 `stageCounter()`，按阶段读各自语义：切分显示 `总/总`，逐句显示 `已解析/总`，其余阶段没有可数单位就不显示数字 |
| 逐句少算 | 新增 `analysed = done + needsReview`，计数只描述**已完成的工作** |
| 待复核判定 | `needsReview` 只表示**引用在原文中找不到**（真实缺陷）；声明的不确定单独存 `uncertainty_notes`，在句卡里提示「此句结构校验通过，但部分引用需人工复核」不再误报 |
| 历史数据 | schema v3 只**加列**不做猜测性改写；提供 `revalidateSentences()` 逐句把已存分析重新对原文校验，幂等且报告 `checked/cleared/flagged` |

实测：该文章 15 句从 4 done + 11 needs_review → **15 done**，两处计数均显示 `15/15`。

顺带修掉一个测试盲区：`validateJsonSchemaValue` **返回违规数组而不是抛出异常**，我最初的 try/catch 写法让 schema 校验永远通过——正是它放过了 `revalidated` 字段未声明的线上错误。现在 `schema-check` 会真正执行每个工具（含每个 `action` 分支）并把返回值喂给校验器。

## 12. 采集配置与来源策略（第 5 轮）

### 12.1 采集配置的最终字段

| # | 字段 | 控件 | 默认 |
|---|---|---|---|
| 1 | 难度 | CEFR A1–C2 区间选择（点边界收缩、点区间外扩展） | B1–B2 |
| 2 | 来源 | 21 个来源多选，全选/全不选 | 全选 |
| 3 | 文章发布时间 | 24 小时 / 7 天 / 30 天 / 自定义（天数输入） | 7 天 |
| 4 | 文章类型 | 12 种类型多选 | 全选 |
| 5 | 过滤敏感内容 | 单选开/关 | 开启 |
| 6 | 词数范围 | 最小/最大数字输入 | 800–1500 |

存储用 `sourceIds`（注册表 id）而不是域名，这样改名或加镜像域不会让已存配置失效。读取时 `normalizeProfile()` 兼容旧结构（旧的 `sources[{domain}]` 会映射成 ids）。

### 12.2 来源策略（抽象）

`lib/sources.js` 的 `SOURCE_REGISTRY` 是唯一事实来源，每条声明：

- `kind`: `feed`（RSS/Atom）/ `html`（列表页抓取）/ `catalog`（可浏览目录）
- `levelHint`: 该媒体自身的难度带（分级站点显式分级，综合媒体按体裁估计）
- `articleTypes`: 该来源产出的类型，用于类型过滤
- `paywalled` / `note`: 已知限制，直接展示给用户

`buildStrategies()` 把每条包装成统一接口：

```
list(context)      → 候选（feed 解析 / 列表页抓链 / 目录）
extract(html,url)  → 站点特有的后处理（如 News in Levels 的 level-N、Gutenberg 的许可证围栏）
classify(item,profile) → { articleType, cefrLevel, levelBand }
accepts(item,profile)  → 难度/类型不在规格内则整源跳过
```

新增来源 = 往注册表追加一行（必要时加一个 `EXTRACTORS` 函数），**不需要改 discover 流程**。`tests/sources.mjs` 用 46 项断言把这个契约固定下来（含「不得把 feed 指向 HTML 页」这类结构一致性）。

抓取分两种：`fetchArticle`（HTML 正文，SSRF 校验 + 5MB）与 `fetchText`（feed/列表页，SSRF 校验 + 6MB）。两者共用同一套重定向重校验、私网拒绝与超时。

### 12.3 实测（真实网络）

21 个来源：**17 个可用**，一次采集 5.8 秒、262 个候选。失败/受限来源会逐条报告原因，不伪装成功：

| 来源 | 结果 | 原因 |
|---|---|---|
| AP News | `FETCH_BLOCKED` | 403，反爬 |
| New Scientist | `FETCH_BLOCKED` | 406（同时它的 C1–C2 也落在规格外） |
| Arts & Letters Daily | `FETCH_BLOCKED` | Cloudflare 挑战页 |
| Engoo Daily News | `NO_LINKS_FOUND` | 页面可访问但为 JS 渲染，未提取到链接 |
| The Conversation / Longreads / Aeon / Nature / MIT TR | 抓取成功但整源跳过 | 难度带高于所选 B1–B2，属预期行为 |

`sourceHealth` 记录每个来源的上一次结果，采集表单在来源名后标 ⚠ 并给出错误码，避免用户反复踩同一个 403。

### 12.4 过程中修掉的问题

1. **SSRF 误杀全部域名**：本机 DNS 走 fake-IP 代理，域名解析到 `198.18.0.0/15`；我把它当作私网拒绝，导致所有抓取失败。改为读取 profile 的 `web-fetch-lan` 配置，把声明的 synthetic 段作为例外，真实私网（`127/10/169.254` 等）仍然拒绝。
2. **SQLite 绑定对象**：`classify()` 最初把 `levelHint`（`{scheme,min,max}` 对象）写进 `cefr_level` 列，`node:sqlite` 直接抛 `cannot be bound`。改为 `bandFor()` 取单一 CEFR 级，区间另存。
3. **feed 指向 HTML 页**：CNN 10 / BBC Learning English / Engoo 被我误声明为 `feed`，结果解析出 0 条或体积超限。改为 `html` 列表抓取。
4. **`stripHtml` 标点错位**：`<b>` 被替换成空格产生 `markup .`，已修正为标点前不留空格。

## 13. 视觉重构为 Bento Grid 2.0（第 6 轮）

先把规范写成文档 `docs/bento-grid-2.0.md`，再按规范编码；`tests/bento.mjs` 把规范变成可执行断言。

**规范来源**：本会话内 web_search 不可用（缺 `DEEPSEEK_API_KEY`），而本机代理会把 Bing/Google/DDG 的搜索结果重写成无关内容（返回「弁当文化」「Speedtest」等页面）。因此改为**直接读取线上实现**的样式证据：

- Framer 首页内联 CSS：`.framer-imndr5 { border-radius:25px; grid-template-columns:repeat(3,minmax(50px,1fr)) }`、`gap:40px 20px`、圆角分布 8px×35 / 15px×9 / 18px×7 / 25px×4。
- Apple 商店卡片 CSS：圆角 10/12/15/18px，`0 0 18px 18px` 半圆角单据。
- Supabase 卡片：圆角 6–8px + 细描边，说明「边框优先」的另一种取向。

文档对每条规则标注 `[measured]`（实测数值）、`[derived]`（从实现推断）、`[constraint]`（宿主约束），不把自拟规范说成官方标准。

**落地的六条规则**：12 列 board；span 只取 12/8/6/4/3；全 board 单一 `gap: var(--er-s-3)`；圆角随面积 18→24→28；阴影最多两层；暗色单独一套变量。

**改动的文件**：`src/20-style.js` 整体重写；`src/40-ui.js` 新增 `Board`/`Cell`/`SPANS`；Dashboard、Discover、Articles、ArticleDetail、Knowledge、Review、Settings 改为 board 组合。实测各页 span：Dashboard `12,8,4,12`、Settings `6,6,6,12`、Review `8,4`、Discover `12,8`——是真正的非对称 bento，不是等高卡片列表。

**测试自身的一个 bug**：阴影层数统计最初按逗号切分，把 `color-mix(a, b, c)` 的内部逗号当成层分隔，误报 4 层。改为按括号深度计数，并加了一条自检断言防止这个 helper 再次退化。

## 14. 采集文章数量（第 7 轮）

采集规格新增第 7 项「采集文章数量」，默认 **1**。

| 位置 | 改动 |
|---|---|
| `DEFAULT_PROFILE` | `articleCount: 1` |
| `normalizeProfile()` | 缺省/非法值回退 1，越界夹到 1–20，`0`/负数夹到 1，小数取整 |
| `discover()` | 数量由 **profile** 决定；调用方传 `limit` 时仅覆盖本次（工具/测试用），不改 profile |
| 返回体 | 新增 `wanted`，让界面能说「目标是 N 篇」而不只是「返回了 M 条」 |
| 界面 | 数字输入 + 1/3/5/10 快捷 chip；开始按钮显示 `开始发现 · N` |

两个实现细节值得记下：

- **`Number(null)` 与 `Number('')` 都是 0**。最初用 `Number.isFinite(Number(x))` 判断，会把「字段缺失」误判成 0 再夹成 1——结果虽正确但逻辑错误，且对 `''` 同样误判。改为先判断字段是否存在再做数值转换。
- **浏览器端原本写死 `limit: 12`**。这个值会完全架空新设置。改为不传 limit，由 profile 决定；并在测试里断言 bundle 内 `call('discover', …)` 只有一处且不含数字 limit，防止以后又被写死。

`tests/article-count.mjs`（20 项）覆盖默认值、夹取、四舍五入、非数字、缺省、超大字符串、显式覆盖不污染 profile、导出保留字段，以及客户端不得硬编码 limit。

## 15. 视觉回归修复（第 8 轮）

用户截图暴露三个问题，都已修复并加了防回归断言。

### 15.1 文字贴着边框

阅读页的原文卡片与右侧解析卡片仍在用旧类 `er-card`。Bento 重构后 `.er-card` **不再带内边距**（内边距归 `.er-cell` / `.er-card-pad` 管），于是正文每一行都从边框上开始。改为 `.er-cell er-article-card` / `.er-cell er-side-card` 后恢复正常内边距。

同类隐患已全量排查：现在 `src/` 里没有任何 `className: 'er-card ...'` 的元素用法，只剩文字类 `er-card-sub` / `er-card-title`。

### 15.2 句子粘连

原文渲染成 `changes.A new study` —— 缺了句号后的空格。原因在切句：`splitSentences()` 对每句 `trim()`，所以把句子文本直接拼起来就丢了空格。修复在渲染层：句子 span 之间补一个真实空格，而不是去改切句（切句的偏移量已被阅读定位、笔记、语音多处依赖，不能动）。

### 15.3 来源 / 文章类型标签偏大

两个标签渲染成正文大小，与「难度（CEFR）」等不一致。原因是样式规则写成 `.er-field > label`，只匹配**直接子元素**；而 `ChipGroup` 的 label 包在一层用于放「全选」按钮的 flex 行里，所以从未命中。

修复：抽出 `.er-field-label` 类，供嵌套场景复用，规则与 `.er-field > label` 合并书写。

### 15.4 保存规格按钮移到开始发现左侧

原本保存按钮在表单底部、开始发现在下方独立一行，两个操作分居两处。现在合并成**一行操作区**（顶部一条分隔线）：左侧是「已选来源数」，右侧依次是 `保存规格`、`开始发现 · N`。`ProfileForm` 不再接收 `onSave`，改由页面统一持有这两个动作，避免同一操作出现两处入口。

### 15.5 测试

`tests/deep-render.mjs` 新增 5 项断言：阅读面板必须是带内边距的 cell、句子之间必须有空格、还原后的正文不能出现 `句号紧跟大写字母`、每个 `.er-field` 内所有 label 必须带统一类、保存按钮必须紧邻开始按钮左侧。

两条新断言已做**反向验证**：手工把两处缺陷改回去，测试分别报 `2 unstyled label(s)` 与 `save=124 start=123`，确认它们真的会失败而不是空跑。

## 16. 阅读页三处修正（第 9 轮）

### 16.1 空框：无失败也显示了「失败摘要」

`FailureSummary` 与 `NoteList` 自身会在「无失败 / 无笔记」时返回 `null`，但我又把它们各包了一层 `<Cell>`。外层 Cell 有边框和标题，内层返回 `null`，于是留下一个**有标题没内容的空框**（截图 1）。

修法：去掉外层包装，让组件自己决定是否渲染。同类问题一共两处（失败摘要、笔记列表），一并修掉。

### 16.2 分析面板在两种模式重复

「导语 / 重点单词 / 逐句解析 / 短语搭配 / 复盘」这组 tab 在两个分支里都渲染了。按你的选择改为**模式归属**：

| 模式 | 侧栏内容 |
|---|---|
| 双栏精读 | 失败摘要 + **逐句解析** + 笔记 |
| 连续阅读 | 失败摘要 + **文章级分析 tabs** + 笔记 |

两种模式不再重叠，也不再重复。

### 16.3 tab 吸顶

tab 条是滚动容器（`.er-side`）的第一个子元素，加 `position: sticky; top: 0` 即可吸顶；背景改为不透明（97% 卡片色）并加一道向下投影，避免下方内容透出。`Tabs` 组件新增 `sticky` 参数，只有阅读页启用，其余页面不受影响。

### 16.4 测试本身的两个 bug（值得记下）

给这三处加断言时，前两次都是**假阴性**：

1. **图标被当成文本**：我统计 Cell 的文本内容时把 `<svg>` 的 path 数据也算进去了，导致空 Cell 看起来「有内容」。
2. **遍历看不到子节点**：测试框架把渲染结果存成 `{type, props, children}`，但部分节点的内容只在 `props.children` 里。原来的 `flat()` 只读 `children`，于是整棵子树被跳过——这也是为什么会打印出「11 个 cell 但只有 3 个有 eyebrow」这种自相矛盾的结果。

最终改为**源码级断言**：扫描 `h(Cell, {...}, ...)` 的子节点，检查是否把「自己会渲染 Cell 的组件」又包了一层。这个判据直接对应缺陷成因，比推断渲染树更可靠。已做反向验证：把包装加回去，断言立刻报 `✗ FailureSummary is not wrapped in a second cell`。

模式归属也用源码断言：切出三元表达式的两个分支，检查 `sentencePanel` 只出现在 split、`insightPanel` 只出现在 continuous。

## 17. 首页去掉重复入口（第 10 轮）

首页欢迎块的 `发现文章 / 导入 URL / 打开知识库` 三个按钮与左侧导航完全重复，右侧头像也只是装饰，一并移除。

同时删掉欢迎块底部那行 `3 篇文章 · 1 个知识点` —— 它和下方四张统计卡重复表达同一组数字。

清理范围（不只是隐藏，是真的删掉）：

| 项 | 处理 |
|---|---|
| 三个 CTA 按钮 | 删除标记与 `onNavigate` 传参 |
| 头像块 | 删除标记 |
| `.er-welcome-avatar`、`.er-welcome-actions` | 删除 CSS 规则 |
| `home.ctaDiscover` / `ctaImport` / `ctaLibrary` | 删除中英文 locale 键 |

首页节点数从 169 降到 141，Bento 布局不变（`12+8+4+12=36`，正好三整行）。

保留的入口：左侧导航（唯一导航）、搜索框（唯一非导航入口）、最近阅读列表、整体进度。

`tests/deep-render.mjs` 新增 6 项断言：首页不得出现三个 CTA 键、不得有头像块、四张统计卡仍在、搜索框仍在。反向验证过——把「发现文章」按钮加回去，立刻报 `✗ the dashboard offers no duplicate "home.ctaDiscover" entry`。

## 18. 阅读页：去重复词汇条 + 原文链接（第 11 轮）

### 18.1 删掉文章上方的词汇条

标题下方那排可点击单词（`WordStrip`）与右栏「重点单词」tab 是同一份数据，属重复展示。删除标记、`WordStrip` 组件定义本身、以及它的导出项——不是隐藏，是代码里不再存在。

单词仍可从「重点单词」tab 进入，点击行为不变。

### 18.2 标题行加「原文链接」

标题右侧新增一个小链接，指向文章抓取时的 `sourceUrl`。样式做成**元信息**而非常规按钮：淡紫底、1px 描边、11px 字号，与 B/C1 徽标同高，不抢标题视觉。

`target="_blank"` + `rel="noreferrer noopener"`，`title` 显示完整 URL。没有 `sourceUrl` 的文章（手动粘贴）不渲染该链接。

### 18.3 测试

新增 6 项断言：不得有词汇 chip 条、词汇 tab 仍存在、原文链接存在且 href 正确、`target="_blank"`、有本地化标签。

已反向验证：把词汇条加回并删掉链接，测试立刻报 `✗ no vocabulary chip strip above the article — 10` 与 `✗ the article links back to its source — 0`。

过程中遇到两个测试自身的问题，值得记下：

1. **`flat()` 重复计数**：它会把同一子树访问多次，导致链接被数成 7 个。改为按元素去重。
2. **断错了树**：分析 tab 位于 `ArticleInsights` 内，而该组件只在「连续阅读」分支挂载，默认渲染的双栏分支里根本没有它——所以断言必须查源码而不是渲染树。

## 19. 知识库改为手动加入（第 12 轮）

### 19.1 根因

`searchKnowledge()` 用的是 **LEFT JOIN**：

```sql
FROM vocabulary v LEFT JOIN user_knowledge k ON ...
```

左连接意味着**即使没有 user_knowledge 行，候选也会被列出**。解析一篇文章后，词汇/短语/搭配/句子表里就有了数据，于是它们立刻全出现在知识库——看起来就像"自动进入"。

`reviewQueue()` 同样如此，未加入的词汇也会进入复习队列。

### 19.2 改法

**语义**：解析只产生**候选**（`vocabulary` / `phrases` / `collocations` / `sentences` 等）；知识库是 `user_knowledge`，**有行才算加入**。

| 位置 | 改动 |
|---|---|
| `searchKnowledge` 四类查询 | `LEFT JOIN` → `JOIN`（内连接） |
| `reviewQueue` | 同样改内连接，`COALESCE(k.mastery_level,0) < 3` → `k.mastery_level < 3` |
| `getArticle` 句子 | 补 `t.id AS sentence_id` 与 `inLibrary` 标志（单词原本已有 `favorite`） |
| `updateKnowledge` | `favorite: false` 时**删除该行**，而非留一行 `favorite=0` |

最后一条是关键：如果只把 `favorite` 置 0 而不删行，实体因为"行仍存在"会继续留在知识库里——测试正是抓到了这个（`✗ a removed phrase leaves the library — 1`）。

### 19.3 界面入口

| 位置 | 控件 |
|---|---|
| 单词卡（重点单词 tab） | 每张卡右上「加入知识库 / 已在知识库」 |
| 短语列表 | 每行右侧同样的按钮 |
| 搭配列表 | 每行右侧同样的按钮 |
| 逐句解析面板 | 句子上方同样的按钮 |

按钮统一由 `LibraryToggle` 渲染：未加入为实心主色按钮（`+ 加入知识库`），已加入为幽灵按钮（`✓ 已在知识库`），点击可移出。

单词卡原来是 `<button>`，内部再放按钮会产生嵌套按钮的非法 DOM，因此改为 `div[role=button]` 并保留键盘可达性。

另外把知识库页的「仅收藏」筛选换成「仅未掌握」：所有列表项本来就都是已加入的，按收藏筛选恒为无操作；按掌握度筛选才真正有用。

### 19.4 线上数据验证

改造后实测线上库：

```
候选池 -> vocabulary 15 / phrases 15 / collocations 20 / sentences 15
知识库 -> 仅 1 条（word "consolidate"，fav=1, m=2）
```

那 1 条是此前主动收藏并标过熟练度的，保留正确；其余 64 个候选都没有自动进入。

### 19.5 测试

`tests/knowledge-optin.mjs`（28 项）覆盖：四类候选解析后知识库仍为空、加入单个实体只出现该实体、`getArticle` 返回的 `inLibrary` 随加入/移出变化、复习队列跟随、移出即删除、四类查询必须是内连接、以及四个界面入口的挂载。

反向验证：把 word 查询改回 `LEFT JOIN`，立刻报 `✗ word: nothing is listed before adding — 1`。

## 20. 去掉「逐句精读」tab（第 13 轮）

### 20.1 判断依据

该 tab 只渲染**句子列表**：序号 + 解析状态徽标 + 原文 + 中文译文。它的能力在别处都已存在：

| 它能做的 | 已有替代 |
|---|---|
| 点句子看分析 | 直接在正文点句子（双栏右侧显示分析） |
| 上一句 / 下一句 | 逐句面板的 `‹ ›` |
| 逐句进度 | 顶部「逐句 15/15」 |
| 定位失败句子 | 失败摘要自带跳转 |

唯一失去的是「一屏纵向看所有句子译文」，但它不与正文并排，阅读价值有限。确认删除。

### 20.2 清理范围

| 项 | 处理 |
|---|---|
| tab 定义 | 删除 |
| tab 内容分支 | 删除 |
| `SentenceList` 组件 | 删除 |
| `ArticleInsights` 的 `onJump` 参数 | 删除（唯一使用者已消失） |
| 阅读页传的 `onJump` | 删除 |
| `reader.tabSentences` / `reader.sentencesTitle` | 删除中英文 locale 键 |

现在分析 tab 为四项：导读 / 重点单词 / 短语搭配 / 复盘。

**顺带修掉的命名混淆**：`reader.modeSplit` 叫「双栏精读」，`reader.tabSentences` 曾叫「逐句精读」——同页两个「精读」指不同东西。后者删除后此问题自然消失。

### 20.3 一次真实的误删

删 `SentenceList` 时我按「从它的注释到下一个注释」区间切割，但 `LibraryToggle` 恰好定义在这两个注释之间，被一并删掉。`tests/knowledge-optin.mjs` 立刻报 `✗ a shared add control exists` —— 上一轮写的测试抓住了这一轮的疏忽。

已恢复，并新增断言：`LibraryToggle` 必须恰好定义一次、必须被至少三个列表使用。这样以后再删相邻组件，误删会被立刻发现。

### 20.4 测试里修掉的三个自身问题

1. **按索引取 tab**：`tabControls[1]` 取到的是模式切换器而非分析 tab，因为两类 tab 混在同一数组里。改为按 `role="tablist"` 定位。
2. **`includes('er-tabs')` 子串重叠**：`er-tabs-bar`、`er-tabs-sticky` 都含 `er-tabs`，同一元素被数多次。改为按空格切分类名。
3. **`flat()` 重复遍历**：同一子树被多次访问，元素被重复计数。改为按元素身份去重。

## 21. 进度条两个「15/15」的歧义（第 14 轮）

### 21.1 问题

进度条上「切分 已完成 15/15」与「逐句 已完成 15/15」并列，看起来像同一个计数。实际含义不同：

| 阶段 | 数字含义 | 是否进度 |
|---|---|---|
| 切分 | 全文被切成 **15 句** | 否，一次性动作的结果 |
| 逐句 | 15 句中 **已解析 15 句** | 是，解析时从 1/15 递增 |

三层原因：两个都渲染成 `x/y`；标签只有两个字没有说明；切分用了比值形式，天然像进度条。

### 21.2 改法

1. **切分不再用比值**：`15/15` → `15`。一个数字表示“切成 15 句”，比值才表示进度。
2. **每个阶段加一行说明**（9.5px 三级文字，名称下方）：
   - 切分 → 「切成几句」
   - 逐句 → 「每句精读」
   - 其余六个阶段同样补上主题说明
3. **标签从硬编码中文改为 locale 键**（`stage.*` / `stageHint.*`），中英各 16 条。此前标签是写死的中文，英文界面下会露馅。

### 21.3 修掉一条“把 bug 写进测试”的断言

`tests/stage-counter.mjs` 原本断言 `stageCounter('SEGMENTATION', {sentences:15}) === ' 15/15'`。这条断言把**正是要消除的歧义**固化成了预期——测试是绿的，界面是误导的。

改为断言它真正想表达的：切分输出**裸总数**、**不得含 `/`**。这类“测试锁定了错误行为”的情况比测试缺失更危险，因为它会让后续修复看起来像回归。

新增 5 项断言：标签必须本地化、八个阶段都必须有 hint 键、hint 必须渲染、切分输出裸总数且不含 `/`、逐句必须是 `analysed/total`。反向验证：把比值和 hint 撤掉，三条立刻报错。

## 22. 原文链接补齐到列表 + 示例文章的诚实处理（第 15 轮）

### 22.1 现状核查

阅读页的原文链接在第 11 轮已加（`er-source-link`），代码一直在。但用户看不到它，原因是：

```
三篇文章 sourceUrl 全为 null（都是内置示例 "English Reader Sample"）
```

链接的渲染条件是 `article.sourceUrl ? ... : null`，所以对示例文章**永远不渲染**。功能没坏，是数据没有可跳转的目标。

### 22.2 本轮改动

1. **文章列表也有原文入口了**。此前只有阅读页能跳原文，列表页没有。现在 `ArticleRow` 的右侧操作区也有同一个 `er-source-link`（`onClick` 阻止冒泡，不会误触发打开文章）。
2. **示例文章的 `sourceUrl` 显式写成 `null`**，而不是缺字段。三篇是自建内容，没有真实出处；**编一个地址等于制造死链**，比不显示更差。显式 null 让「没有原文」成为数据事实，而不是遗漏。

### 22.3 验证链接确实生效

用一条带真实 URL 的导入文章跑通两端：

```
sourceUrl stored: https://www.theguardian.com/...
=> reader renders the link: YES
=> list row renders the link: YES
```

即：只要文章来自 URL，阅读页和列表页都会出现可点击的「原文链接」。

### 22.4 测试

新增 5 项断言：阅读页链接存在、href 正确、`target="_blank"`、`rel` 含 `noopener`、以及**无 `sourceUrl` 时不得渲染**（防止以后改成恒显示而产生死链）。另加一条：示例文章的 `sourceUrl` 必须是 `null`/缺省，不得是编造值。

## 23. 句子解析面板吸顶（第 16 轮）

### 23.1 问题

右侧「句子解析」面板的**面板标题栏**（含 `‹ ›` 上下句按钮）和**当前句原文 + 加入知识库按钮**，都随 `.er-side` 一起滚动。往下读解析内容时，这两块会滚出视野——而它们恰恰是理解下方解析的参照物。

### 23.2 做法

`.er-side` 是单一滚动容器，因此给两层子元素加 `position: sticky`：

| 层 | 定位 | z-index |
|---|---|---|
| 面板标题栏（`.er-side-card > .er-side-head`） | `top: 0` | 3 |
| 句子原文 + 加入按钮（`.er-sentence-sticky`） | `top: var(--er-side-head-h)` | 2 |

两层都用 `background: var(--er-card)` 不透明背景，否则下方解析文字会透出来；各自加一条底部分隔线，滚动时视觉边界清楚。

### 23.3 一个避免硬编码的决定

句子头需要排在标题栏下方，最初写了 `top: 33px`。这是个**对标题栏高度的猜测**：字号变化、标题换行、或日后加按钮都会让它错位，表现为两层重叠或中间出现缝隙。

改为声明一次 `--er-side-head-h: 33px`，第二条规则引用变量。测试里额外断言**这个值只声明一次**——将来若要改成实测高度，只需改一处。

严格说 `33px` 仍是估算值。真正的解法是 `ResizeObserver` 实测高度，但那会在滚动中触发布局读取。考虑到标题栏是固定字号 + 固定内边距，估算值在这里是稳的；若后续标题行数可变，应换实测。

### 23.4 测试

`tests/bento.mjs` 新增 6 项断言：标题栏必须 sticky、必须不透明、句子必须 sticky、必须用变量偏移、变量只能声明一次、两层 z-index 必须有序。

反向验证：把 `sticky` 改回 `static` 且背景改透明，立刻报 `✗ the sentence panel header is sticky` 与 `✗ the sticky header is opaque`。

## 24. 侧栏改为固定框架（第 17 轮）

### 24.1 上一轮的思路是错的

第 16 轮我给侧栏加了 `position: sticky` 让标题吸顶，但**没解决根本问题**：`.er-reader--fill .er-side` 整体是滚动容器，所以每张卡片连同**它的边框**一起向上滚。sticky 只是把其中两层钉住了，边框照样在动——截图里红框的上边缘会随滚动上下移动，正是这个原因。

### 24.2 改法：滚动从「列」下移到「卡片体内」

```
之前：.er-side { overflow-y: auto }        ← 整个列滚动，边框跟着走
现在：.er-side { overflow: hidden }        ← 列是固定框架
      .er-insights        { flex:1; overflow:hidden }   ← 卡片是固定框
      .er-insights-body   { flex:1; overflow-y:auto }   ← 只有体内滚动
```

句子面板同理：`.er-side-card` 是框，`.er-side-scroll` 是滚动体。

于是边框、tab 条、面板标题都成为**框架的一部分**，永远不动；只有内容在框内滚动。

### 24.3 连带清理

- 面板标题的 `position: sticky` **已无意义**（它现在在滚动容器之外），改回普通流布局。
- 句子原文的 sticky 目标从 `.er-side-card` 改为 `.er-side-scroll`，`top: 0`（不再需要减去标题高度）。上一轮引入的 `--er-side-head-h` 变量随之失去用途。
- 失败摘要与笔记卡片不再是全高，改为 `max-height: 40%` 各自滚动，否则它们会挤压 tab 面板。

### 24.4 测试

`tests/bento.mjs` 替换了过时的 sticky 断言，新增：

| 断言 | 含义 |
|---|---|
| 侧栏不得是滚动容器 | `overflow: hidden` |
| tab 体必须滚动 | `.er-insights-body` 有 `overflow-y: auto` |
| tab 体必须填满框架 | `flex: 1` |
| 句子体在卡内滚动 | `.er-side-card > .er-side-scroll` |
| 句子吸顶、标题不吸顶 | sticky 只应出现在句子层 |

另有一条旧断言 `the side column scrolls inside its cell` 描述的是**已被淘汰的架构**，改为 `is a fixed frame, not a scroller`。这类「测试记录了旧设计」的情况和上次 `stage-counter` 一样，必须在改架构时同步更新，否则它会替旧行为辩护。

反向验证：把侧栏改回 `overflow-y: auto`，立刻报 `✗ the side column is a fixed frame, not a scroller` 与 `✗ the side column does not scroll`。

## 25. 学习记录与贡献图（第 18 轮）

### 25.1 先说一个前提问题

现有的 `dashboard.readingMinutes` **不能**用来画贡献图。它是 `SUM(articles.reading_minutes)` ——所有文章**预估**阅读时长的总和。用它会得出一个假结论：收藏 20 篇没读的文章，热力图会显示「学习」了很多。这不是学习记录，是待办清单的体量。

所以必须新建事件表。

### 25.2 表结构（schema v4）

```sql
CREATE TABLE study_events (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,          -- 本地日历日 YYYY-MM-DD
  kind TEXT NOT NULL,         -- read / vocabulary / phrase / collocation / sentence
  article_id TEXT,
  entity_type TEXT, entity_id TEXT,
  seconds INTEGER DEFAULT 0,  -- 实测秒数，非估算
  created_at TEXT NOT NULL
);
```

**`day` 用本地时区而非 UTC**。`now()` 存的是 ISO UTC，但 `substr(updated_at,1,10)` 在东八区早上 8 点前会算成前一天——现有 `reviewedToday` 就有这个隐患。学习记录按学习者自己的日界线走，所以单独存 `localDay()`。

### 25.3 记录点

| 交互 | kind | 时长来源 |
|---|---|---|
| 保存阅读进度 | `read` | 客户端实测秒数 |
| 复习评分 / 加入知识库 | `vocabulary` 等 | 客户端实测秒数 |

`recordStudy()` 包在 try/catch 里且只 `logger.warn`——**学习日志绝不能因为写库失败而阻断阅读**。

一个刻意的决定：保存进度时若没带 `seconds`，**仍然记一次事件，但时长记 0**。「今天读过」是事实，「读了多久」在没测量时就是未知，不猜。

### 25.4 聚合（`studyActivity`）

返回：按天的 `{day, events, seconds, minutes, kinds}`、窗口内合计、`currentStreak` / `longestStreak`、按 kind 的时间分布、`peakSeconds`。

连续天数的两条规则：
- 今天没学但昨天学了 → 仍算连续（还没到判负的时候）
- 中间缺一天就断，不做补偿

### 25.5 热力图

GitHub 风格：7 行（周一到周日）× 26 列（半年）。

**分档用相对刻度**：以该用户自己的峰值日为基准分四档，而非固定分钟数。固定刻度会让轻度用户整片是 1 档、重度用户整片是 4 档，两种都看不出分布。

其他细节：未来日期只留虚框不填色；每格 tooltip 写「日期 · N 次记录 · M 分钟」；月份标签在月份变化的列上方。

### 25.6 迁移验证

线上库迁移前是 v3 且无 `study_events`。先备份到 `/tmp/live-before.sqlite`，再触发迁移：

```
schema: 3 → 4
study_events exists: true
articles: 3 (不变) | user_knowledge: 1 (不变)
```

数据完好。随后真跑一次保存进度，确认端到端：

```
before: {seconds:0, events:0}
after : {seconds:90, minutes:2, events:1, activeDays:1, currentStreak:1}
today : {day:"2026-11-08", kinds:["read"]}
```

### 25.7 测试

`tests/study-history.mjs` 36 项，覆盖空状态、真实记录、跨天聚合、**连续天数的诚实性**（今天+前天 = 连续 1 而非 2）、窗口裁剪与夹取、按类型分布、网格构建规则，以及两条防退化断言：

- 聚合查询必须读 `study_events`，**不得出现 `reading_minutes`**
- 写入失败必须被捕获（学习日志不能阻断阅读）

## 26. 吸顶范围修正：整个头部区块（第 19 轮）

### 26.1 我上一轮判断错了

第 16、17 轮我以为问题在「标题栏也要吸顶」，于是给它加 `position: sticky`，只把标题那 4 个字钉住。截图显示：**「句子解析」+ 句子原文 + 加入知识库按钮是同一块，应该整体固定**，而 sticky 只钉住了句子那一行。

更关键的是，第 17 轮改固定框架后，`.er-side-head` 已经在滚动容器**之外**，本来就不会动——那两轮加的 sticky 从那一刻起就是死代码。

### 26.2 正确做法：把头部移出滚动容器

```
之前：.er-side-card
        ├─ .er-side-head        （框架内，不动）
        └─ .er-side-scroll      （滚动容器）
             ├─ 句子 + 按钮      ← 用 sticky 硬钉，仍会滚
             └─ 解析内容

现在：.er-side-card
        ├─ .er-side-head        （框架内）
        ├─ 句子 + 按钮          （框架内，走 flow，天然不动）
        └─ .er-side-scroll
             └─ 解析内容
```

`SentencePane` 改为返回 `{ head, body }`：调用方把 `head` 放在滚动容器**之前**，`body` 放在容器**之内**。头部不再是滚动内容，也就不需要任何 sticky。

### 26.3 清理

- 删除 `.er-sentence-sticky` 的全部样式，sticky 在这个卡片里已无用武之地
- 新增 `.er-side-card > .er-sentence-head { flex: none }`
- 更新 `tests/bento.mjs` 里那条**记录旧设计**的断言（`the sentence pins, the header does not`），改为断言「两者都在滚动容器之外、卡片内不得出现 sticky」

这是第三次遇到「测试替旧设计辩护」了（前两次是 `stage-counter` 的 `15/15`、`side column scrolls`）。改架构时必须同步改断言，否则它会阻止正确修复。

### 26.4 测试

新增 3 项结构断言：`SentencePane` 必须返回 `head`/`body` 两段、`pane.head` 必须在 `er-side-scroll` 之前、`pane.body` 必须在其中。

反向验证：把 `pane.head` 塞回滚动容器，立刻报
`✗ the pane head is placed before the scroller — head=842 scroll=755`。

## 27. 解析进度条自动收起（第 20 轮）

### 27.1 规则

八个阶段各自占一个格子，全部成功时它只是把「已完成」重复八遍，却占掉阅读区一大块高度。改为：

| 条件 | 默认状态 |
|---|---|
| 有 `FAILED` 或 `NEEDS_REVIEW` | **展开**（需要处理，必须看见） |
| 有阶段正在运行 | **展开**（让人知道在跑） |
| 全部成功 | **收起**，只留一条进度条 |

无论哪种，右上角都有展开/收起按钮可以覆盖自动判断。收起时若有待处理项，进度条旁会出现一个粉色徽标提示数量。

### 27.2 响应式：不测量，靠 flex

「下面的内容自动收缩/扩展」没有用 JS 测量高度，而是利用已有的填充布局：

```
.er-page--fill > .er-reader-band { flex: none }   ← 条只占自身高度
.er-reader--fill { flex: 1; min-height: 0 }       ← 阅读区吃掉剩余高度
```

收起的条更矮（`padding: 10px`、gap 归零），腾出的高度**自动**被下方的 `.er-reader` 拿走——因为它是 `flex: 1`。不需要 `ResizeObserver`，也不会在滚动中触发布局读取。

### 27.3 状态设计

`open` 用三态：`null` 表示跟随自动规则，`true`/`false` 表示用户手动指定。这样「手动展开」不会被下一次渲染的自动判断覆盖，同时默认行为仍然由阶段状态决定。

### 27.4 测试里修掉的遍历 bug

断言「展开时应有 8 个阶段格」时数出了 16 个。原因是我对 `mount()` 的返回值又做了一次 `flat()` —— 而 `renderTree` 返回的**已经是扁平的元素列表**，再展开一次会把每个节点的子元素重复计一遍。

这是本项目第四次因为「测试脚手架自身行为理解错」而写出假断言（前三次：图标被当成文本、`props.children` 未被遍历、`flat()` 重复计数）。共性教训：**断言失败时先怀疑测量方式，再怀疑被测代码**。

### 27.5 反向验证

把 `expanded` 硬编码为 `true`（永不收起，即用户报告的现象），三条断言立刻失败：

```
✗ all-success collapses by default
✗ collapsed shows no stage grid
✗ the learner can force it shut
```

## 28. 真实学习时长与活动明细（第 21 轮）

### 28.1 上一轮有个致命的遗漏

第 18 轮做了 `study_events` 和热力图，第 19 轮还强调「时长靠实测不靠估算」。但**前端从来没传过 `seconds`**：

```js
// 改之前
call('saveProgress', { articleId, sentenceIndex: active, ratio })
```

后端 `recordStudy({ seconds: Number(input.seconds) || 0 })` 于是永远收到 0。线上数据可以证明：

```
live totals:   {"seconds":90, "events":7}   ← 7 条事件里 6 条是 0 秒
events sample: [{"seconds":0, ...}, {"seconds":0, ...}]
```

只有我上一轮测试时手动传了 90 秒。**「实测」变成了空话**，热力图的时间维度全是 0。这是我自己写的功能没闭环，测试也没覆盖到「客户端是否真的上报」。

### 28.2 真实计时

```js
readMs.current        // 累计毫秒
visibleSince.current  // 当前可见片段起点
```

- 只在 `document.visibilityState === 'visible'` 时累计，切走标签页就停
- 保存进度时把当前可见片段折算进去，上报后清零
- 与进度保存共用同一个 900ms 防抖，所以一次阅读会话不会写几十行

**同一个长文分两次读**：第一次 20 分钟、隔天再读 10 分钟，会分别记在前一天和今天——因为每次上报只带「这段时间」。

另加一条健壮性处理：没有 `document` 的环境（如渲染测试）直接跳过可见性监听，退化为纯经过时间。这是测试先崩出来才发现的。

### 28.3 活动明细（对齐参考图）

参考 GitHub 的贡献页，学习记录页现在是两段：

| 区块 | 内容 |
|---|---|
| 顶句 | 「过去一年学习 3 小时 20 分，共 28 天」 |
| 热力图 | 52 周 × 7 天，分档按本人峰值 |
| 学习明细 | **按天分组的活动流**：每天列出读过的文章、类型、事件数、**该文当天花费的时长** |

明细来自新增的 `includeEvents` 参数（默认不返回，避免热力图请求携带冗余数据），以及新增的 `byArticle` 聚合（每篇文章累计时长 + 最后阅读日）。

### 28.4 测试

`tests/study-history.mjs` 从 36 项扩到 49 项，新增两组：

- **按文章聚合**：秒数相加、带标题、记录最后阅读日
- **客户端确实上报**：断言 `saveProgress` 调用必须包含 `seconds`、必须用 `visibilitychange`、每次上报后计数清零、无 DOM 时不得崩溃

最后一条是这轮的关键教训：上一轮的测试只验证了后端能存时长，**没有验证前端会送时长**，于是「实测时长」这个特性整体失效而测试全绿。

## 29. 阅读页左右框对齐（第 22 轮）

### 29.1 症状

右侧「句子解析 / 文章导读」的框明显比左侧文章卡片**内缩一圈**，看起来矮一截、窄一截，两框上边缘对不上。

### 29.2 根因：框中框

左侧文章卡片是**一个** `er-cell`（1px 边框 + 20px padding）。

右侧却是**两层**：

```
er-cell er-insights          ← 外层框（与左侧同规格）
  └─ Card（文章导读）        ← 内层又画了一个 1px 边框 + padding
```

内层 `Card` 的边框和 padding 把内容往里推，于是视觉上多出一道内缩的框，两栏自然对不齐。

这是第 17 轮「侧栏改固定框架」时留下的：为了让内容可滚动，我给 `ArticleInsights` 套了 `er-cell er-insights` 作为外框，却**没有去掉原来的 `Card`**，结果叠成了两层。

### 29.3 改法

新增 `InsightSection`：只有标题行（图标 + 标题 + 计数），**不画边框**。五个 tab（导读 / 重点单词 / 短语 / 搭配 / 复盘）全部改用它。

现在左右两侧都只有一个 `er-cell`，边框、圆角、padding 完全一致，上边缘自然对齐。

### 29.4 测试

`tests/bento.mjs` 新增 4 项：

| 断言 | 防的是什么 |
|---|---|
| 右侧必须是单个 `er-cell` | 外框被拆掉或改名 |
| 内部不得出现 `h(Card,` | 再次退化成框中框 |
| 至少 5 处使用 `InsightSection` | tab 面板被换回带边框的容器 |
| 分节标题不得声明 border | 用 CSS 偷偷补回边框 |

反向验证：把 `guide` tab 改回 `Card`，立刻报
`✗ no nested Card is drawn inside it` 与 `✗ tab panels use a borderless section — 4`。

## 30. 折叠按钮点不动（第 23 轮）

### 30.1 三个缺陷叠在一起

**① 传错了值**

```js
onClick: () => onToggle(expanded)   // 传当前值
```

父组件是 `setBandOpen`，于是它把状态设成**它本来就有的值**，状态不变、不重渲染——按钮看起来完全死了。正确是传 `!expanded`。

**② 图标根本没渲染**

`Button` 的 `iconOnly` 分支只渲染 `icon` 属性：

```js
iconOnly ? null : children
```

而我把 chevron 放在 `children` 里传进去。即使点击生效，**按钮上也是空的**，用户看不到可点的东西。

**③ 状态与提示属性被丢弃**

`Button` 只透传 `type/className/onClick/disabled`，`title` 和 `aria-expanded` 全被丢掉。所以按钮既没有 tooltip，也不向辅助技术报告展开状态。

### 30.2 修法

| 缺陷 | 修复 |
|---|---|
| 传当前值 | `onToggle(!expanded)` |
| 图标位置错 | chevron 改走 `icon` 属性 |
| 属性被丢 | `Button` 改为 `...rest` 透传，`aria-label` 支持覆盖 |

### 30.3 为什么之前的测试没抓到

之前关于折叠的断言**只检查源码字符串和 class 名**——`expanded === null ? ... : ...` 存在、`--collapsed` 类会被加上。这些在「点击没反应」的情况下**全部为真**。

真正缺的是：**没有任何测试真的触发过 `onClick`**。整个测试套件里，按钮一直只被当作静态元素检查。

这轮补了一个 `BandHost`：让测试自己持有 `useState`，点击后重新挂载，然后断言「一次点击后阶段格从 0 变 8」。反向验证——把 `!` 去掉——立刻报：

```
✗ one click expands it — 0
✗ the button now reports expanded
```

`0` 正是用户看到的现象。

### 30.4 教训

**检查「元素存在」不等于检查「交互可用」。** 一个按钮可以渲染出来、有正确的 class、有正确的文案，然后什么都不做。凡是带 `onClick` 的东西，测试必须真的点一次。

## 31. 连续阅读右栏高度被限制在 40%（第 24 轮）

### 31.1 根因：一条 `:not()` 漏掉了一个类

侧栏里有四类子元素，我写了三条尺寸规则：

| 规则 | 意图 |
|---|---|
| `.er-side > .er-cell.er-side-card` | 分栏模式主面板，撑满 |
| `.er-side > .er-cell.er-insights` | 连续模式主面板，撑满 |
| `.er-side > .er-cell:not(.er-side-card)` | 失败摘要 / 笔记，**限制在 40%** |

第三条的 `:not(.er-side-card)` 本意是"排除主面板"，但它只排除了**分栏模式**的主面板。连续模式的主面板是 `.er-insights`，**不含** `.er-side-card`，于是被这条规则命中：

```
flex: none; max-height: 40%;
```

结果连续阅读右栏只占 40% 高度、下面留空，与左侧文章卡片对不齐。**分栏模式正常、连续模式异常**——这解释了为什么上一轮修不好。

### 31.2 修法

```css
.er-cell:not(.er-side-card):not(.er-insights)
```

并把两条"撑满"规则合并为同一处声明，两个类并列，避免以后再分叉。

### 31.3 一个真实的构建事故

我在 CSS 注释里写了 ``` `.er-side-card` ```（带反引号）。`20-style.js` 的整份样式是**一个模板字符串**，反引号直接把它截断，构建产物里 JS 语法错误：`ReferenceError: side is not defined`。

已去掉反引号，并加了一条断言：**样式模板内部不得出现任何反引号**。这类错误在构建时才暴露，而 `node --check src/20-style.js` 查的是模块本身、查不到模板内部，所以必须靠专门断言。

### 31.4 测试

`tests/bento.mjs` 新增 4 项：

| 断言 | 防的是什么 |
|---|---|
| 两个主面板类共用一条 `flex: 1` 规则 | 两条分支再次分叉 |
| 40% 上限规则必须排除 `.er-insights` | 本轮这个 bug |
| 该规则确实设了 `max-height` | 变成无效规则 |
| 样式模板内无残留反引号 | 构建截断 |

反向验证：把 `:not(.er-insights)` 去掉，立刻报 `✗ the bounded rule excludes the insights panel too`。

## 32. 词数范围改为「不限制 / 可选范围」（第 25 轮）

### 32.1 之前的问题

词数范围是**强制生效**的两个数字输入（默认 800–1500），而且它当时只参与打分，**不同文章有多长都不会被拒绝**。设置看起来生效、实际没有约束力。

### 32.2 新语义

| 模式 | 行为 |
|---|---|
| **不限制**（默认） | 完全忽略长度，任何篇幅都保留 |
| **可选范围** | 启用 min/max，并多出第三个选择：**允许截断文章** |

截断开关只在「可选范围」下出现；切回「不限制」会强制把 `truncate` 归零，避免存下「不限制却要截断」这种自相矛盾的配置。

范围内超长文章的处理：

| `truncate` | 结果 |
|---|---|
| 关 | **跳过**，并报告 `Article is longer than N words and truncation is off.` |
| 开 | **按句截断**到 max，返回 `truncated: true` 与实际词数 |

截断后若剩余词数低于 min，同样判定为不可用（`tooShortAfterTruncate`）——切得太碎的文章没有阅读价值。

### 32.3 关键约束：截断不切句子

`truncateToWords()` 只保留**完整句子**，取「能放下的最长整句序列」。若强行按词数切，分析器会把半句话当成完整句子去解析语法结构，产出必然错误。

实测（480 词正文）：

```
max=50  -> 48 词 / 4 句 / 丢弃 36 句
max=120 -> 120 词 / 10 句 / 丢弃 30 句
max=400 -> 396 词 / 33 句 / 丢弃 7 句
```

三种预算下都是整句、都以句号结尾。代价是预算用不满（50 词只用了 48）——这是「不切句」的必然代价，不是缺陷。

### 32.4 测试

`tests/word-limit.mjs`（30 项）：

- 截断：预算内、丢尾、以句号结尾、**保留的每句都必须原文出现**（证明没切断）
- 边界：单句超预算仍保留整句、空输入、不足预算时原样返回
- 归一化：默认 unlimited、范围内可开截断、切回 unlimited 强制关闭、未知模式回落
- 强制：短于 min 拒绝、超长且不截断拒绝、超长且截断则切、切后不足 min 也拒绝
- 界面：两个模式选项、范围输入仅在 range 下出现、截断开关只在范围内、切回 unlimited 清空截断

反向验证：把 `truncateToWords` 改成按词切（naive slice），立刻报
`✗ it ends on a sentence boundary — "repeated daily becomes a large"` 与
`✗ no sentence was cut in half`。

## 33. 学习记录时间范围 + 首页热力图（第 26 轮）

### 33.1 后端：新增显式区间

`studyActivity` 原先只接受「最近 N 天」（`days`），无法表达「2026 年 1 月」这种具体区间。新增 `from`/`to`：

```js
studyActivity({ from: '2026-01-01', to: '2026-02-28' })
// -> window: 59, startDay, endDay
```

**上界必须显式参与查询**。最初四条 SQL 只有 `day >= ?`，范围会向后泄漏——测试正是这样抓到的（见 33.4）。现在四条查询都带 `day >= ? AND day <= ?`。

两种兜底：区间反向（from > to）或格式不合法时，退回「最近 N 天」，而不是返回空结果。静默返回空会让人以为"这段时间没学习"，与"参数写错了"是两回事。

### 33.2 前端：五个预设 + 自定义

| 选项 | 天数 | 网格列数 |
|---|---|---|
| 一周 | 7 | 2 |
| **一个月（默认）** | 30 | 5 |
| 三个月 | 90 | 14 |
| 半年 | 182 | 27 |
| 一年 | 364 | 53 |
| 自定义 | from/to | `ceil(window / 7)` |

`buildWeeks` 原先固定锚定「当前周」，自定义历史区间会画错位置。新增 `endDay` 参数，按区间结束日倒推网格。

### 33.3 首页：复用同一个网格

首页新增 `StudyMini`：`ActivityGrid` 的紧凑版（`er-heat--compact`），默认一个月，右上角「查看全部」跳转完整页面。

三个有意为之的决定：

1. **复用组件而非复制**。`ActivityGrid` 提到共享作用域后，首页与历史页读同一份数据、同一套分档规则，不会各自漂移。
2. **独立加载**。`StudyMini` 有自己的 `useLoad`，历史查询慢不会拖住问候语和统计卡。
3. **无数据时给一句话，不画空网格**。空网格看起来像"功能坏了"。

首页布局从 `12+8+4+12`（三行）变成 `12+8+4+12+12`（四整行），仍然对齐。

### 33.4 测试

`tests/study-history.mjs` 增至 56 项，新增 9 项区间断言：两端都有界、返回请求的起止日、窗口长度推导、被排除的日期确实缺席、反向/畸形区间兜底、trailing 模式仍正常。

`tests/deep-render.mjs` 新增 13 项：五个预设与自定义都存在、默认值为 `1m`、自定义发 `from`/`to`、预设发 `days`、首页含 `StudyMini`、默认 30 天、复用 `ActivityGrid`、有跳转链接，以及**首页热力图必须真的画出 35+ 个格子且带分级**（防止"组件在但不渲染"）。

反向验证：把 `day <= ?` 从查询里去掉，立刻报
`✗ an explicit range bounds both ends — 3` 与 `✗ the excluded day is absent`。

## 34. 截断改成内联开关（第 27 轮）

### 34.1 形态调整

截断从「一整行两个 chip（允许 / 不允许）」改成**紧挨词数输入框右边的单个复选框**，默认选中。

| 改动 | 原因 |
|---|---|
| 两个 chip → 一个 checkbox | 这是二元开关，不是多选项；chip 让一行挤进五项 |
| 默认 `false` → `true` | 在范围内，截断比静默跳过更友好 |
| 并入输入框同一行 | 「上限多少」和「超了怎么办」属于同一个决定 |

### 34.2 两个容易踩的点

**① 显式 `false` 会覆盖默认值**

归一化只在字段**缺失**时补默认。前端把归一化后的 profile 原样回传时，`truncate: false` 会作为显式值存下去——用户切到范围模式也不会自动变 true。所以切换模式时前端必须显式写值：

```js
truncate: option.value === 'range'
```

**② 重复点击不该复活开关**

用户在范围内手动关掉截断后，再点一次「可选范围」不该把它打开。加了判断：

```js
if ((profile.wordLimitMode === 'range') === (option.value === 'range')) return;
```

### 34.3 一个被测试纠正的过严断言

新增开关用了 `<label className="er-check">`（包裹 checkbox 的语义标签），触发了「每个 `.er-field` 内的嵌套 label 都必须带 `er-field-label`」这条断言。

**断言本身过严**：字段命名标签和控件标签本来就该不同。改为区分两类，并额外断言「确实存在控件标签」——否则这个区分可以被绕过。

### 34.4 测试

`tests/word-limit.mjs` 35 项，新增/改写 5 项：范围内默认开启、仍可显式关闭、切换模式设置截断、重复点击无变化、必须是单个 checkbox 且无残留 chip 对。

`tests/deep-render.mjs` 新增 4 项：表单真的渲染出 checkbox、默认勾选、`checked` 跟随 profile、开关只在范围分支内。夹具 profile 改为 `wordLimitMode: 'range'` 才能覆盖到这段。

反向验证：把 checkbox 改回 chip 对，立刻报
`✗ truncation is a single checkbox` 与 `✗ no truncate chip pair remains`。

## 35. 首页热力图改一年且限制尺寸（第 28 轮）

### 35.1 为什么它那么高

`.er-heat-cell` 用了 `aspect-ratio: 1`。网格列宽由容器等分，**首页只有 5 列**（一个月），每列约 220px，于是每格也是 220px 高，7 行累加 ≈ **1540px**——一整屏只装得下热力图。

根因是「方格」这个规则只在列数很多时才成立。列少时它会把每格放大到荒谬的尺寸。

### 35.2 两处改动

| 改动 | 作用 |
|---|---|
| 首页改 **53 列（一年）** | 列多了，每格自然变小 |
| 给 `.er-heat-cell` 加 `max-height/max-width: 16px` | **硬上限**：无论几列都不会撑大 |
| `.er-heat--compact` 内 `aspect-ratio: auto` + `height: 84px` | 紧凑版按固定高度分布，不再逐格算比例 |

只做第一条不够可靠：未来若又改成「三个月」，格子会再次变大。上限是保底。

首页现在展示**一年**的长弧线，历史页才是用来缩小窗口的地方——两者分工明确，不再重复「都是最近一个月」。

### 35.3 测试

`tests/bento.mjs` 新增 4 项尺寸断言：格子必须有高/宽上限、紧凑版必须放弃方格比例、紧凑块必须有固定高度。

`tests/deep-render.mjs` 把「默认一个月」改为「覆盖一年」，并把格子数量下限从 35 提到 **365**（一年）。

反向验证：去掉 `max-height/max-width`，立刻报
`✗ heat cells have a height ceiling` 与 `✗ heat cells have a width ceiling`。

## 36. 学习记录去掉时间选择，修复格子尺寸（第 29 轮）

### 36.1 去掉范围选择

上一轮刚加的五档区间（一周/一月/三月/半年/一年/自定义）全部移除，固定为**一年（53 列）**。

原因不是功能不好，而是**格子数量决定格子尺寸**：区间越短列数越少，同一套 `aspect-ratio: 1` 规则下格子就越被放大。一周只有 2 列时，格子宽度是整卡的一半，视觉上完全失衡。固定一年就消除了这个变量。

删除的东西是彻底删掉，不是隐藏：`RANGE_PRESETS` 常量、日期输入、`rangeId`/`custom` 状态、按区间推导列数的逻辑。

### 36.2 格子尺寸的第二次修正

上一轮我加了 `max-height/max-width: 16px` 硬上限来压住尺寸。**这是错的方向**——上限让格子变成固定的小点，列少时它们松散地飘在框里、彼此留着大片空隙，看起来像"格子展示有问题"。

正确做法是让尺寸**由网格轨道决定**：

| 规则 | 效果 |
|---|---|
| `width: 100%` + `aspect-ratio: 1` | 格子填满所在列并保持正方形 |
| `.er-heat-grid { max-height: 210px }` | 整块高度有界，不会随窗口变宽而放大 |
| 紧凑版 `height: 100%` + 块高 96px | 首页按固定高度均分七行 |

于是列多则格子小、列少则格子大，**均匀且不留缝**，总高度由块而非格子控制。

### 36.3 测试

`tests/deep-render.mjs`：把六条区间选择断言换成五条「固定一年」断言（常量存在、查询一年、无预置、无日期输入、网格始终 53 列）。

`tests/bento.mjs`：尺寸断言改为「由轨道决定」——必须 `width: 100%`、必须保留方格比例、**不得有像素上限**、网格必须有高度界、紧凑版必须填满轨道。

反向验证：把 `max-height: 16px` 加回去，立刻报 `✗ no fixed pixel ceiling remains`。

## 37. 知识库空状态按类型区分（第 30 轮）

### 37.1 问题

四个 tab 共用同一套空状态文案：

```js
title: t('knowledge.emptyTitle')        // "知识库还是空的"
description: t('knowledge.emptyBody')   // "单词、短语、搭配和句子会沉淀到这里"
icon: h(Icons.letters)                  // 单词专用图标
```

于是「单词有 15 条、短语 0 条」时，短语 tab 显示「知识库还是空的」——**与事实不符**：知识库不空，只是短语为空。图标也错误地用了字母图标。

### 37.2 改法

按 `kind` 分别取文案与图标：

| 类型 | 图标 | 提示 |
|---|---|---|
| 单词 | letters | 还没有单词 → 在阅读页点「加入知识库」 |
| 短语 | link | 还没有短语 → 在「短语搭配」里点「加入」 |
| 搭配 | layers | 还没有搭配 → 同上 |
| 句子 | quote | 还没有句子 → 选中句子后点「加入」 |

每条提示**说明该类型的加入入口**，而不是笼统地说"解析后会沉淀"。旧文案还有一处事实错误：它说"解析文章后会沉淀到这里"，但第 12 轮已改成手动加入——这句话早就不成立了。

保留 `knowledge.emptyTitle` / `emptyBody` 作为兜底，供未来未知类型使用。

### 37.3 测试夹具的缺陷

`searchKnowledge` 的夹具返回固定数组、**不理会 `kind`**，所以四个 tab 拿到同样的数据，短语 tab 永远不会走空状态分支。改为按 kind 返回：只有 `word` 有数据，其余三个为空——这才让该分支可被观测。

### 37.4 测试

新增 9 项：有数据的 tab 不显示空状态、三个空 tab 各自显示自己的键、**不得出现旧的全库提示**、三条消息必须互不相同。

反向验证：把文案改回共用，立刻报
`✗ phrase tab shows its own empty message` 等五条失败。

## 38. 首页热力图改为直接复用（第 31 轮）

### 38.1 之前其实有第二套实现

首页的 `StudyMini` 虽调用了同一个 `ActivityGrid`，但通过 `compact: true` 另开了一套样式分支：

```css
.er-heat--compact .er-heat-cell { aspect-ratio: auto; height: 100% }
.er-heat--compact .er-heat-body { height: 96px }
```

加上独立的标题、独立的空状态、独立的三项统计行——**同一份数据，两套外观、两套文案**。这就是"看起来像另写的一个"的来源。

### 38.2 改法：抽出一个卡片，两处调用

新增 `StudyHeatmapCard`（在 `105-history.js`）：

- 标题、图标、「连续 / 活跃天数 / 累计时长」三项、网格、空提示，全在一处
- 接受 `actions` 参数，首页借此挂「查看全部」链接

历史页与首页现在都是 `h(StudyHeatmapCard, { t, activity, actions })`。首页只剩下加载与错误处理，不再有自己的视觉实现。

**`compact` 参数与整套 `.er-heat--compact` CSS 一并删除**——留着一个没人用的分支，正是下次分叉的种子。

### 38.3 顺手修掉的两个测试问题

1. **重复声明**：我在测试块里又写了一次 `const history`，与上方已有声明冲突，直接 `SyntaxError`。这类错误 `node --check` 会报，但只在跑测试时才发现。
2. **过时的紧凑断言**：两条断言仍在检查 `er-heat--compact` 是否存在。删掉该变体后它们本就该失败——改为断言**不存在**。

### 38.4 测试

`deep-render`：断言首页渲染的是 `StudyHeatmapCard`、首页**不得出现私有网格实现**（`!includes('h(ActivityGrid,')`）、不再渲染紧凑变体。

`bento`：尺寸断言合并为一条——**整套样式里不得出现 `.er-heat--compact`**。

反向验证：把首页改回私有 `h(ActivityGrid, ...)`，立刻报
`✗ it renders the shared heatmap card` 与 `✗ the dashboard has no private grid implementation`。

## 39. 侧栏品牌名改单行（第 32 轮）

### 39.1 成因：不是样式换行，是两个元素

```js
h('div', { className: 'er-brand-name' }, 'English'),
h('div', { className: 'er-brand-name', style: { marginTop: -4 } }, 'Reader')
```

两个 `div` 各占一行，于是视觉上是「English / Reader」上下堆叠。第二个还带 `marginTop: -4` 手动收紧间距——说明这是刻意做出来的两行排版，不是自动换行。

### 39.2 改法

合并为一个节点 `'English Reader'`，并加 `white-space: nowrap` 防回归：

```css
.er-brand-name {
  white-space: nowrap;
  max-width: 100%;
}
```

侧栏宽 188px、左右 padding 各 12px，可用 164px；「English Reader」在 12.5px 字号下约 90px，空间充裕。

`nowrap` 不只是保险：如果未来侧栏变窄或字号变大，浏览器会**自动折行**回到两行——那正是要避免的现象，所以要用 CSS 明确禁止。

### 39.3 测试

新增 5 项：源码里只能有一个 `er-brand-name` 节点、文案必须是完整 `'English Reader'`、不得残留 `marginTop: -4`、样式必须 `nowrap`、渲染输出里只能画出一个品牌名元素。

反向验证：把两行排版改回去，四条同时失败（`✗ the brand renders one name node — 2` 等）。

### 39.4 两个测试自身的坑

1. **`slice` 区间取空**：我用 `indexOf("groups,")` 作为终点，但 `groups,` 在文件更早处（导航循环）也出现过，导致截取到的是空串。改为以 `er-rail-foot` 为界。
2. **`flat()` 重复计数**：`mount()` 返回的已经是扁平数组，再 `flat()` 会重复遍历子节点，同一个元素被数两次。品牌名因此报「4 个」——改为直接过滤 `nodes` 而不再展开。

这是本项目第五次因「测试脚手架自身行为」写出假断言。共性仍是：**断言失败时先查测量方式，再查被测代码**。

## 40. 侧栏分组：复习与学习记录移出知识库（第 33 轮）

### 40.1 问题

原有两个组，第二个叫「知识库」，却装了六项：

```
知识库
  ├─ 单词 / 短语 / 搭配 / 句子   ← 真是知识库的四类实体
  ├─ 复习中心                   ← 对它们做练习
  └─ 学习记录                   ← 记录学习时长
```

后两项**不是知识库的内容**，而是「对知识库做练习」和「记录学习行为」。归在同一组会让人以为复习中心是第五种知识实体。

### 40.2 改法

拆出第三组：

| 组 | 标题 | 成员 |
|---|---|---|
| main | （无标题） | 首页 / 采集文章 / 我的文章 |
| knowledge | 知识库 | 单词 / 短语 / 搭配 / 句子 |
| **practice** | **练习与进度** | 复习中心 / 学习记录 |

分组标题原先**硬编码**成 `t('nav.knowledge')`，只对第二个组成立。改为按组取键 `t(\`nav.group.${group.id}\`)`，并补齐中英各两条。这是拆组必须一并修的地方——否则新组会顶着「知识库」的错误标题。

### 40.3 测试

新增 11 项：恰好三组、四个知识项都在 knowledge 组、`review` 与 `history` **都不在** knowledge 组、两者同属 practice 组、分组标题按组取值、两个标题键都存在。

反向验证：把两项放回 knowledge 组，立刻报
`✗ review is not in the knowledge group — knowledge` 等四条失败。

## 41. 采集结果持久化 + 运行进度日志（第 34 轮）

### 41.1 持久化：数据本来就在，缺的是读取

采集一直把候选写入 `discovered_articles` 表。线上数据可证：

```
{"status":"candidate","n":275},{"status":"imported","n":1}
```

275 条候选都在。**丢的只是前端**：结果存在 React state 里，切页面即失。而且没有任何读取接口。

修法：新增 `pendingCandidates()`，只返回 `status = 'candidate'` 的行（已导入的变成文章，混进来会干扰选择），按分数与时间排序。页面挂载时水合；导入成功后从列表移除并刷新。

### 41.2 进度：轮询而非推送

采集 21 个源要几秒，期间界面完全无反馈。但 Host RPC 是**单次请求-响应**，长任务无法推送更新。

方案：采集在内存里发布运行状态（`discoverRun`），前端以 600ms 轮询 `discoverProgress()` 读取。刻意**不持久化**——进度只在运行存活期间有意义。

记录三层信息：

| 层 | 内容 |
|---|---|
| 总览 | `running`、`total/done`、候选数、错误 |
| 逐源 | `pending → fetching → ok/empty/failed` + 条数 |
| 日志 | 时间戳 + 级别 + 中文消息，最新在前，上限 200 行 |

### 41.3 一个必须处理的坑

`discover()` 原来直接执行。若中途抛错，`discoverRun` 会永远停在 `running: true`，前端**无限轮询**。把真正的扫掠抽成 `runDiscovery()`，外层 `discover()` 用 try/catch 包裹，catch 里关闭运行、记录错误、写日志「采集中断」。

### 41.4 测试

`tests/discovery-persist.mjs`（34 项）：

| 组 | 覆盖 |
|---|---|
| 持久化 | 只返回 candidate、排除 imported、按分数排序、行字段完整 |
| 导入后移除 | 已导入行从列表消失 |
| 进度 | 运行关闭、逐源跟踪、日志三层、每行带时间戳与级别 |
| 异常关闭 | catch 关闭运行、记录错误、空源也正常关闭 |
| 前端契约 | 水合调用、轮询、完成即停、卸载清定时器、扫掠不被轮询阻塞 |

反向验证：去掉水合调用，立刻报
`✗ a stored candidate reappears after remount`。

一个说明：测试里"取到条数"那条改成了**接受终端状态**——测试环境的网络阻断会让个别源失败，那是来源健康问题，不是进度契约。

## 42. 设置页空白的排查与两个真实缺陷（第 35 轮）

### 42.1 排查过程（诚实记录）

我**没有复现出空白**。逐层验证的结果：

| 层 | 验证方式 | 结果 |
|---|---|---|
| 构建产物 | 部署文件与工作区逐字节一致（SHA 相同） | 一致 |
| 模块求值 | 无 `__ModuleLoader__` 的 VM 求值 | 干净加载 |
| Host RPC | 直接调用部署后的 `lib/index.js` 路由 | `settings` 返回 `ok: true`、14 个键 |
| 真实数据渲染 | 把线上 `settings` 载荷灌进测试框架渲染设置页 | **594 节点、60 行配置、无异常** |
| 嵌套深度 | 检查 `100-knowledge.js` 各声明的括号深度 | 全部顶层 |

排查中还浪费了几轮：探针脚本的 `useEffect` 存根不执行加载、`effect()` 没调用回调、`flat()` 重复遍历——**三次失败都是测量工具的问题，不是被测代码**。

### 42.2 排查中发现并修掉的两个真实缺陷

**① `Button` 用 `...rest` 把插件专属属性透传到 DOM**

`Button` 改为支持 `title` / `aria-expanded` 时用了 `...rest`。任何调用者多传的属性（比如误传的函数）都会落到 `<button>` 上成为非法属性。改为**显式白名单**：`title / ariaLabel / ariaExpanded / testId`。

**② 设置页没有错误分支**

```js
if (data.status === 'loading' && !data.data) return ...骨架...
// 之后直接渲染，没有 error 分支
```

`settings` RPC 一旦失败，页面会渲染出 `vundefined · schema undefined`、所有徽标显示 undefined——**视觉上接近空白**。已补上错误分支：显示错误信息 + 重试按钮。

### 42.3 最可能的解释

我无法复现空白，但结合第 31 轮的事故——当时构建产物的 CSS 模板被反引号截断，**浏览器可能缓存过那份坏包**（模块加载失败 → 插件完全不挂载 → 整页空白）。

**请先硬刷新（Ctrl+Shift+R）**。若仍空白，请打开浏览器控制台（F12 → Console），把红色报错发给我——那是我下一步定位的唯一可靠输入。

## 43. 设置页空白的真正根因（第 36 轮）

### 43.1 用户给的关键线索

「不是整个插件空白，而是设置页空白；而且一旦打开设置页，切到其他会话再回来还是空白。」

这说明：**设置页在渲染时抛异常，React 卸载了整棵组件树**——所以连侧栏一起消失，看起来像整个插件空白；切会话回来重新挂载，再次崩溃，所以永远空白。

### 43.2 根因：展开覆盖了键

```js
speech: {
  available: ..., engine: ..., voices: VOICES,   // 数组：5 个 {id,label}
  ...speech.stats(),                              // 展开覆盖：voices: 5（数字！）
}
```

`speech.stats()` 里 `voices` 是**计数**（`VOICES.length`），与 `settings.speech.voices` 的**语音列表**键名相撞。展开在后面，数组被数字覆盖。

设置页对它调用 `.map()`：

```js
(settings.speech?.voices ?? []).map((voice) => h('option', ...))
```

对数字调用 `.map` → `TypeError` → 设置页崩溃 → 整棵树卸载 → **整页空白，连侧栏一起消失**。

### 43.3 为什么测试没抓到

测试夹具的 `settings.speech.voices` 是**数组**（我手写的），所以 `.map` 正常。**夹具与真实载荷在这里不一致**，而这个不一致恰恰就是 bug 本身。

修法两层：

| 层 | 改动 |
|---|---|
| 根因 | `stats()` 的键改名 `voices` → `voiceCount`，不再与数组冲突 |
| 防御 | 设置页的语音下拉改为 `Array.isArray(...) ? ... : []`，坏载荷不再崩溃 |

### 43.4 测试

`tests/word-limit.mjs` 增至 40 项，新增 5 项载荷形状断言：`speech.voices` 必须是数组、每项必须有 `id`/`label`、计数必须在自己的 `voiceCount` 键下、`stats()` 不得再发出 `voices` 键、设置页必须防非数组。

反向验证：把键改回 `voices: VOICES.length`，立刻报
`✗ speech.voices is the voice list, not a count — number`。

### 43.5 复盘

这轮我犯了两个错误：

1. **第一轮我说「无法复现」**——那时我已经有「设置页在真实浏览器崩溃」的线索，却停在「代码在测试环境能渲染」，没有去核对**真实载荷与夹具的差异**。用户后来补充的「切会话再回来还是空白」才让我意识到是渲染期崩溃。
2. **夹具是我手写的**，它必然与我的实现假设一致，所以测不出实现自己的错。凡是「真实载荷的形状」，必须有断言直接核对载荷本身，而不是只测渲染。

## 44. 设置页可编辑化（第 37 轮）

### 44.1 三处改动

| 项 | 之前 | 现在 |
|---|---|---|
| 模型 | 只读徽标 | **下拉选择**，默认「跟随会话模型」 |
| 逐句并发 | 只读数字 | 数字输入（1–5） |
| 失败重试 | 只读数字 | 数字输入（1–5） |
| 重点词汇数 | 只读数字 | **整行移除** |

### 44.2 模型选择：覆盖优先于会话

模型解析顺序（`lib/llm.js` `resolveRoute`）：

```
1. 用户在设置里选的模型（app_settings）
2. 会话默认模型（agentDefaultModel.currentSelection）
3. 单一 provider 回退
```

默认无覆盖 → 行为与会话完全一致；选了才偏离。模型列表来自 Harness 真实能力（`llm.listProviders()` × `llm.listModels(provider)`），不是硬编码。

**保存时校验模型仍然存在**：若所选 provider/model 已不在 Harness 列表中，拒绝保存并保留原有设置（返回 `reason: 'unknown-model'`）——避免存下一个失效的模型导致解析报错。

### 44.3 可编辑项存入 app_settings

`tuning` 与 `modelOverride` 存进插件自己的 `app_settings` 表，`bundle.patch` 的静态 config 退为**默认值**。读取顺序：用户设置 → bundle config → 硬编码兜底。

`wordsPerArticle` 从载荷中**彻底移除**（不只是隐藏界面）：它原本限制每篇提取的词数，用户要求取消这个限制。解析提示词不再传 `count`。

### 44.4 排查中发现的一个真 bug

`settings()` 里内联的模型列表把 **provider 对象**传给了 `listModels()`，而该函数的参数是 provider **ID**。结果每个 provider 都返回同一批模型（测试中用桩函数才暴露：`deepseek` 底下列出的是 `glm` 的模型）。

同时这段逻辑与 `availableModelList()` 重复。已改为只保留一处实现，并加断言：`listModels` 必须收到 `id`，且该函数只能有一个定义。

### 44.5 测试

`tests/word-limit.mjs` 增至 58 项，新增：

- **控件**：模型下拉含「跟随会话」项、列出 Harness 模型、并发与重试是绑定 draft 的数字输入、词汇行已消失、保存动作同时写调参与覆盖、覆盖必须到达 LLM 层且**优先于会话默认**、载荷不再含 `wordsPerArticle`
- **模型列表与校验**：每个 provider 贡献各自的模型、新装默认跟随会话、已知模型可保存、未知模型被拒且保留原值、清空可回到会话模型

反向验证：把 `resolveRoute` 里会话默认提到覆盖之前，立刻报 `✗ the override wins over the session default`。

## 45. 设置页：改动即生效 + 左右两栏（第 38 轮）

### 45.1 去掉保存按钮

这些是**偏好设置**，不是需要提交的表单。保存按钮只多一步，且容易忘记按。

改为 `applyDraft(patch)`：控件变化时立即 `setDraft`（乐观更新）并调用 `savePluginSettings`。
保存**被拒**（例如所选模型已从 Harness 消失）时回滚到上一个值并提示——乐观更新必须配回滚，
否则界面会显示一个并未保存的值。

### 45.2 为什么两栏没生效

源里模型与语音单元格都是 `span: 6`，看起来应当并排。但响应式规则在 `≤1180px` 时把布局切到 **6 列**，
并写了：

```css
.er-span-8, .er-span-6 { grid-column: span 6; }   /* 6 列的整行 */
```

于是 `span 6` 在 6 列布局下变成**满宽**，两张卡片上下堆叠。三档宽度的语义没有对齐：

| 断点 | 列数 | `span 6` 应是 |
|---|---|---|
| >1180px | 12 | 半宽（6/12） |
| ≤1180px | 6 | **半宽（3/6）** ← 原来错成整行 |
| ≤900px | 2 | 整行（2/2） |

修法：中档把 `.er-span-6` 映射到 `span 3`。`span 8` 仍是整行（8/12 本来就是主体宽度）。

### 45.3 测试

`tests/word-limit.mjs` 新增 4 项：

- 不得存在保存按钮文案
- 至少 4 处 `applyDraft(` 调用（模型、并发、重试、以及回滚路径）
- 保存被拒时必须 `setDraft(previous)` 回滚
- `≤1180px` 断点里 `.er-span-6` 必须是 `span 3`

反向验证：删掉 `span-6 → span 3` 映射、加回保存按钮，两条断言立刻失败。

## 46. 已知限制

1. 演示文章（sample library）是内置的三篇原创正文，用于首屏可视化；可在设置页一键移除。
2. 模型输出质量取决于当前 profile 的模型；`NEEDS_REVIEW` 状态表示结构通过但存在未通过证据校验的引用。
3. 未做云端同步、多用户、FSRS、语音评分（与需求书 1.3 一致）。

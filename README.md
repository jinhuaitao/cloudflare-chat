# Cloudflare-Chat

基于 Cloudflare Workers 的多通道 AI 对话前端 + Telegram 机器人。入口为 `_worker.js`，模块化组织在 `./src/` 下，通过 `wrangler.toml` 声明式配置，支持连接 GitHub 仓库自动构建部署。当前版本 **v7.1.0**。

## 功能一览

- **多通道 AI 对话前端**：网页聊天 UI，支持多模型 / 多通道（OpenAI、通义千问、DeepSeek 等兼容 OpenAI 接口的通道，支持多 Key Round-Robin 轮询与故障自动切换），内置**可折叠工具调用轨迹胶囊**与**一键导出会话 Markdown (`.md`)**，PWA 可安装，支持离线打开外壳与按需重连探针
- **Telegram 机器人**：多轮对话（默认记 10 轮）、`/model` 内联按钮切换模型、**支持直接发送图片识图（Vision + Agent 工具协同）及上传 `.md`/`.txt`/`.csv`/`.json`/代码文档直接分析或存入知识库**
- **高性能 Agent 模式**（默认开启，Web 与 Telegram 共用）：ReAct 循环自主规划，内置**多级 L1 内存缓存、在途请求合并、上下文智能摘要压缩与 DSML 实时流式防闪烁**，配备 **18 个零密钥工具** —— 🔍 联网搜索、📄 结构化网页抓取（支持 0ms 缓存 `offset` 分页 + Jina 回退）、🌐 维基百科检索、🐙 GitHub 仓库/发版/README 检索、📑 arXiv 学术论文检索、📰 Hacker News 实时科技热榜、💱 实时法币汇率与加密币价、🛰️ Cloudflare DoH DNS 解析与 IP 归属诊断、🧮 科学计算器、🧰 全能工具箱（单位换算/SHA哈希/Base64/URL编解码/UUID/字数与Token统计）、🌤 天气、🕐 时间与日期推算、📚📖 知识库分页精读与多关键词相关性检索（两端可用）、🧠🗑️💾 长期记忆存取与清理 / 文档保存与删除（仅 Telegram）；Web 端查询优先知识库且只读
- **知识库 2.0+**：长期记忆（`remember` / `forget_memory`）+ 知识库文档（`save_doc`，支持 10 万字 L1 缓存分页 `read_doc` 与标题/词频加权全文检索），全部持久化在 R2 的 `kb/` 独立文件夹
- **语音朗读**：浏览器原生语音合成，零成本、零密钥

## 前置条件

- 一个 Cloudflare 账号
- 一个 GitHub 账号（用于存放本仓库）
- 至少一个兼容 OpenAI 接口格式的 API 通道（OpenAI、通义千问、DeepSeek 等均可）

---

# 部署

## 方式一

![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)

## 方式二

# 第一步：在 Cloudflare 中导入 Git 存储库部署

1. 登录你的 Cloudflare 控制台。
2. 在左侧导航栏选择 **Workers & Pages**。
3. 点击 **创建应用程序** (Create application)。
4. 切换到 **Workers** 选项卡。
5. 找到并点击 **连接到 Git** (Connect to Git) 按钮。
6. 按照提示授权绑定你的 GitHub 账号。
7. 在仓库列表中，选择你刚刚创建的 `cloudflare-chat` 仓库。
8. 分支选择 `main`。
9. **构建命令** (Build command) 留空；**部署命令** (Deploy command) 保持默认的 `npx wrangler deploy`。
10. 点击 **保存并部署** (Save and deploy)。

> 项目根目录已包含 `wrangler.toml` 和 `package.json`，构建设置会被自动接管，无需额外配置。  
> `package.json` 中锁定了 `wrangler ^4.0.0`，请勿删除 —— Workers Builds 会优先使用这里声明的 Wrangler 版本，版本过旧会导致下面的 R2 自动置备失败。

---

# 第二步：R2 存储桶（自动创建 + 自动绑定，无需手动操作）

**持久化只用 R2**：KV 免费版每天只有 1000 次写入、单 key 限 1 次写入/秒，而机器人每轮对话都要写历史、Agent 记忆也在增长，很容易撞墙。R2 无日写入上限（免费版每月 100 万次 A 类操作）、单对象可达 5TB、读写强一致。**不需要去控制台手动创建 bucket，也不需要手动添加绑定。** `wrangler.toml` 中已这样声明：

```toml
[[r2_buckets]]
binding = "R2"
```

这里**故意省略了 `bucket_name`**，省略即触发 Wrangler 的自动置备：部署时自动创建 bucket（名字以 Worker 名为前缀，如 `cloudflare-chat-r2`）并绑定，代码里用 `env.R2` 访问。

### R2 文件夹布局

R2 没有真正的目录，用 key 前缀 + `/` 模拟文件夹，控制台按此展示层级。知识库独立存放在 `kb/` 文件夹下：

```
kb/
├── agent_mem_<chatId>      长期记忆索引：JSON 数组（唯一可信源）
├── mem/<chatId>/*.md       每条记忆的 Markdown 镜像（frontmatter + 正文），供控制台浏览
├── docs/<标题>.md          知识库文档：save_doc 工具写入的长篇 Markdown
└── docs/registry.json      文档注册表：标题/来源/大小/时间的索引（去重与列表的唯一依据，损坏自动重建）
tg_hist_<chatId>            Telegram 对话历史（根目录）
tg_user_<chatId>            用户模型选择（根目录）
agent_mode_<chatId>         Agent 开关（根目录）
tg_agent_<chatId>           Agent 断点续做（根目录）
```

---

# 第三步：配置环境变量（关键）

1. 在 Cloudflare 中进入刚部署好的 Worker 项目页面。
2. 点击 **设置** (Settings) → **变量和机密** (Variables and Secrets)。
3. 在 **环境变量** 区域点击 **添加**。

### 多模型 / 多通道配置

按通道编号填写，多个模型用英文逗号 `,` 隔开，格式为 `模型ID:显示名称`；同一个通道支持配置多个逗号分隔的 API Key（自动启用 Round-Robin 负载均衡与 429/5xx 故障切 Key）：

- `API_URL_1` = 通道 1 的 API 地址
- `API_KEY_1` = `sk-key1, sk-key2`（单个或多个密钥）
- `MODEL_1` = `模型:自定义模型名,模型:自定义模型名`

---

# 第四步：启用 Telegram 机器人（可选）

1. 在 @BotFather 处创建机器人，拿到 Bot Token。
2. 在 Worker 的 **设置 → 变量和机密** 中添加 `TG_BOT_TOKEN`。
3. （强烈推荐）再添加 `TG_WEBHOOK_SECRET`，填一串自己生成的随机字符串（例如 `openssl rand -hex 24`）。
4. 重新部署，然后设置 Webhook：

```
https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=https://<你的Worker域名>/tg-webhook&secret_token=<SECRET>
```

### Agent 模式（默认开启，18 项零密钥工具）

| 工具              | 能力                                                                 | 可用端        | 示例触发                        |
| --------------- | ------------------------------------------------------------------ | ---------- | --------------------------- |
| `web_search`    | 联网搜索最新信息（DuckDuckGo HTML + Lite 双端回退 + L1 缓存）                     | 两端         | "今天有什么 AI 大新闻？"             |
| `web_fetch`     | 结构化抓取网页正文（保留标题/链接/代码块/表格，L1 缓存支持 `offset` 0ms 翻页 + Jina 回退）      | 两端         | "总结一下这篇文章：<链接>"             |
| `wiki_lookup`   | 中英维基百科（Wikipedia）权威词条检索与摘要提取                                       | 两端         | "查一下量子纠缠的维基百科定义"            |
| `github_lookup` | GitHub 开源仓库检索、指定 `owner/repo` 详情、最新 Release 与 README 摘要           | 两端         | "查一下 cloudflare/workers-sdk 最新发版" |
| `arxiv_search`  | arXiv 学术论文检索（AI/CS/数学/物理），返回标题、作者、日期、摘要与 PDF 链接                    | 两端         | "搜一下 arXiv 上关于 DeepSeek R1 的论文" |
| `hn_top`        | Hacker News 实时首页科技热榜与高赞技术社区讨论检索                                    | 两端         | "今天 Hacker News 上有什么热门话题？"   |
| `exchange_rate` | 实时法币汇率换算（160+ 币种）+ 主流加密货币（BTC/ETH/SOL 等）实时价格与 24h 涨跌               | 两端         | "10000 日元换算成人民币是多少？BTC 现在多少钱" |
| `net_lookup`    | Cloudflare DoH 域名权威 DNS 解析（A/AAAA/MX/TXT/NS）+ 公网 IP 地理位置与 ASN 归属诊断 | 两端         | "查一下 openai.com 的 MX 记录和 1.1.1.1 归属" |
| `calculate`     | 科学计算器（四则/乘方/括号 + `sqrt`/`log`/`sin`/`cos`/`round`/`pow`/`sum`/`avg`/`pi`/`e`） | 两端 | "帮我算 pow(1.08, 10) * 50000" |
| `toolkit`       | 确定性全能工具箱：单位换算（含亩/坪/MPG油耗/温度/容量）、SHA哈希、Base64/URL编解码、UUID、字数/Token统计 | 两端 | "把 35 MPG 换算成百公里油耗；统计这段文字的字数和 SHA-256" |
| `get_time`      | 当前时间（可指定时区 + Unix 时间戳）+ 日期差推算（`target_date`）+ 日期加减天数（`add_days`）   | 两端         | "距离 2027-01-01 还有多少天？"      |
| `get_weather`   | 城市当前天气 + 未来三天预报（Open-Meteo）                                        | 两端         | "北京明天适合跑步吗"                 |
| `remember`      | 长期记住关于你的事实（R2 持久化，不限条数；同主题改口自动覆盖旧值）                                | 仅 Telegram | "记住，我养了一只猫叫汤圆"              |
| `forget_memory` | 按关键词自然语言删除长期记忆（同步清理 R2 `.md` 镜像）                                   | 仅 Telegram | "忘掉关于旧住址的那条记忆"              |
| `save_doc`      | 把长篇内容保存为知识库文档（真实写入 R2 `kb/docs/`，同链接自动去重）                          | 仅 Telegram | "把这篇文章存成知识库文档"              |
| `list_docs`     | 列出知识库文档标题                                                          | 两端         | （自动调用）                      |
| `read_doc`      | 按标题或关键词读取知识库文档（L1 内存缓存 `offset` 分页续读 + 词频饱和多关键词相关性检索）              | 两端         | （自动调用）                      |
| `delete_doc`    | 删除一篇知识库文档                                                          | 仅 Telegram | "删除知识库文档《甲骨文ARM》"           |

---

# 附：环境变量一览

| 变量                      | 说明                                                                              | 默认值            |
| ----------------------- | ------------------------------------------------------------------------------- | -------------- |
| `TG_WEBHOOK_SECRET`     | Telegram webhook 校验密钥                                                          | 未配置=不校验        |
| `TG_ALLOWED_CHAT_IDS`   | Telegram 聊天白名单（逗号分隔），只响应名单内的聊天                                                  | 未配置=开放         |
| `TG_HISTORY_ROUNDS`     | 机器人记住的最近对话轮数（最大 30）                                                             | `10`           |
| `MAX_TOKENS`            | `/api/chat` 与机器人共用的 `max_tokens`（上限 32000）                                      | `4096`         |
| `RATE_LIMIT_PER_MIN`    | 每 IP 每分钟 `/api/chat` 限额，`0` 关闭                                                  | `60`           |
| `AGENT_MAX_STEPS`       | Agent 单轮任务最大推理步数（上限 12）                                                         | `6`            |
| `AGENT_TIMEOUT_MS`      | Agent 单轮任务总超时（毫秒）                                                               | `240000`（4 分钟） |
| `AGENT_TOOL_TIMEOUT_MS` | 单个工具最长执行时间（毫秒）                                                                  | `30000`（30 秒）  |
| `AGENT_CONTEXT_BUDGET`  | Agent 单轮任务上下文字符预算，超预算裁剪本轮旧 tool 轮次并保留轻量步骤摘要                                     | `24000`        |
| `WEB_AGENT_TIMEOUT_MS`  | 网页端 Agent 单轮任务总超时（毫秒），10 秒 ~ 240 秒                                              | `90000`（90 秒）  |
| `AGENT_STREAM_UPSTREAM` | 设为 `0` 可关闭 Agent 真流式，退回「等整段生成完再显示」                                              | 未配置=开启流式       |
| `TG_API_TIMEOUT_MS`     | Telegram Bot API 单次调用超时（毫秒）                                                     | `15000`（15 秒）  |
| `TG_WEBHOOK_BUDGET_MS`  | webhook 内 Agent 单轮预算（毫秒），10 秒 ~ 240 秒                                           | `55000`（55 秒）  |
| `CORS_ORIGIN`           | 跨域白名单（逗号分隔的完整 Origin，如 `https://chat.example.com`）                              | 未配置=`*`        |

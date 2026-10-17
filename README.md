# ⚡ Cloudflare-Chat

> **基于 Cloudflare Workers + R2 的零依赖多通道 AI 对话前端与全能 Telegram 机器人**  
> 集流式 Web 聊天 UI、PWA 离线应用、Telegram 私聊/群聊多模态机器人、18 项零密钥 ReAct Agent 工具与 R2 知识库于一体。







## ✨ 核心亮点

| 模块 | 核心能力 |
| :--- | :--- |
| 💬 **多通道 Web 前端** | 兼容 OpenAI / DeepSeek / 通义千问等接口及文生图通道；支持 **20 组通道**、**多 Key 轮询（Round-Robin）** 与 `429/5xx` 自动切 Key；内置**可折叠工具调用胶囊**、原生 **TTS 语音朗读**与 **PWA 离线安装** |
| 🤖 **Telegram 全能机器人** | 原生支持**私聊与群聊**（群内默认仅响应 `@提及`、引用回复与 `/命令`）；支持 **Vision 发图识图**、上传 `.md`/`.txt`/`.csv`/`.json`/代码文档直接分析或入库，以及超时任务发送 **「继续」断点续做** |
| 🧠 **极速 ReAct Agent** | Web 与 Telegram 共用推理核心；支持 **DSML 流式防闪烁**、同轮重复调用 0ms 去重、L1 内存缓存、工具并发预读（搜索自动深读前 2 篇正文）与 **18 项零密钥工具** |
| 📚 **R2 知识库 2.0+** | 长期记忆（同主题改口自动覆盖旧值）+ 知识库长文档（支持 10 万字 L1 缓存 `offset` 0ms 翻页与词频加权检索），全量持久化于 R2 `kb/` 目录；**Web 端只读保护，Telegram 端完整读写** |

## 🚀 3 分钟快速部署

### Step 1 · 部署到 Cloudflare Workers

[Deploy to Cloudflare](https://www.google.com/search?q=https%3A%2F%2Fdeploy.workers.cloudflare.com%2F)

或通过 Cloudflare 控制台连接 GitHub 自动构建：

1. 登录 Cloudflare 控制台 → **Workers & Pages** → **创建应用程序** → **Workers** → **连接到 Git**。
2. 选择本仓库与 `main` 分支，**构建命令**留空，**部署命令**保持 `npx wrangler deploy`，点击 **保存并部署**。

> 💡 **R2 存储桶全自动置备（无需手动创建）**  
> `wrangler.toml` 已声明 `[[r2_buckets]] binding = "R2"` 且省略了 `bucket_name`，搭配 `package.json` 中的 `wrangler ^4.0.0`，首次部署时会自动创建并绑定专属 R2 存储桶（如 `cloudflare-chat-r2`），且开启了 `keep_vars = true` 防止重部署冲掉控制台环境变量。

### Step 2 · 配置 AI 模型通道

进入 Worker **设置 (Settings)** → **变量和机密 (Variables and Secrets)**，添加至少一组通道变量：

```ini
API_URL_1 = https://api.openai.com/v1/chat/completions
API_KEY_1 = sk-key1,sk-key2
MODEL_1   = gpt-4o:GPT-4o,deepseek-chat:DeepSeek V3
```

### Step 3 · 启用 Telegram 机器人（可选）

1. 在 Telegram 找 `@BotFather` 创建机器人获取 Token，在 Worker 变量中添加 `TG_BOT_TOKEN` 与随机字符串 `TG_WEBHOOK_SECRET`。
2. 重新部署后，在浏览器访问以下链接完成 Webhook 注册（将 `<...>` 替换为实际值）：

```text
https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook?url=https://<你的Worker域名>/tg-webhook&secret_token=<TG_WEBHOOK_SECRET>
```

## ⚙️ 环境变量全景配置

> 图例：`🔴 必填` 核心运行必需 · `🟠 推荐` 生产环境强烈建议配置 · `🟢 可选` 按需微调（不填即用默认值） · `🔵 自动` 系统自动探测

### 🔌 1. AI 模型与通道配置

系统按 `API_CONFIG` ➔ `API_URL_1..20` ➔ `API_URL` 的优先级加载通道。单通道可填入多个英文逗号分隔的 API Key，自动开启负载均衡轮询与故障切换。

| 变量名 | 级别 | 默认值 | 用途说明与格式示例 |
| :--- | :---: | :---: | :--- |
| `API_URL_1` ~ `API_URL_20` | 🔴 必填其一 | — | 通道 `1~20` 的接口地址（如 `https://.../v1/chat/completions` 或含 `images/generations` 的生图地址） |
| `API_KEY_1` ~ `API_KEY_20` | 🔴 必填其一 | — | 对应通道的 API Key；支持逗号分隔多个 Key（例：`sk-keyA,sk-keyB`） |
| `MODEL_1` ~ `MODEL_20` | 🔴 必填其一 | — | 对应通道的模型列表，格式 `模型ID:显示名`，逗号分隔多个（例：`gpt-4o:GPT-4o,qwen-max:通义千问Max`） |
| `API_URL` / `API_KEY` / `MODEL` | 🟢 可选 | — | 单通道极简兜底配置（当未配置编号通道或 `API_CONFIG` 时生效，格式同上） |
| `API_CONFIG` | 🟢 可选 | — | JSON 数组聚合配置：`[{"url":"https://...","keys":["sk-1","sk-2"],"models":["gpt-4o:GPT-4o"]}]` |
| `MAX_TOKENS` | 🟢 可选 | `4096` | 单次生成最大 Token 数（Web 与 Telegram 共用，合法上限 `32000`） |

### 🤖 2. Telegram 机器人配置

集中管理 Telegram Webhook 鉴权、私聊/群聊触发规则、上下文记忆轮数及运行时间预算。

| 变量名 | 级别 | 默认值 | 用途说明 |
| :--- | :---: | :---: | :--- |
| `TG_BOT_TOKEN` | 🔴 启用必填 | — | `@BotFather` 提供的机器人 Token；未配置时 `/tg-webhook` 静默忽略所有请求 |
| `TG_WEBHOOK_SECRET` | 🟠 推荐 | 不校验 | Webhook 签名密钥（校验请求头 `X-Telegram-Bot-Api-Secret-Token`），可用 `openssl rand -hex 24` 生成 |
| `TG_ALLOWED_CHAT_IDS` | 🟠 推荐 | 全部放行 | 允许对话的私聊 `user_id` 或群组 `chat_id` 白名单，英文逗号分隔（发送 `/help` 可查看当前会话 ID） |
| `TG_HISTORY_ROUNDS` | 🟢 可选 | `10` | 机器人记住的最近对话轮数（上限 `30` 轮，且自动受 12,000 字符安全预算保护） |
| `TG_BOT_USERNAME` | 🔵 自动 | `getMe` 探测 | 机器人用户名（不含 `@`），用于群聊识别 `@提及`；默认自动调 API 获取并缓存，无需手填 |
| `TG_GROUP_REPLY_ALL` | 🟢 可选 | 仅提及时响应 | 群聊全量响应开关：默认群内仅响应 `@机器人`、引用回复与 `/命令`；设为 `1` 则群内每条消息均回复 |
| `TG_API_TIMEOUT_MS` | 🟢 可选 | `15000` | 调用 Telegram Bot API（发消息、拉取图片/文档）的单次超时毫秒数（默认 15 秒） |
| `TG_WEBHOOK_BUDGET_MS` | 🟢 可选 | `55000` | Webhook 单轮 Agent 运行预算（毫秒，范围 `10000`~`240000`）；超时前自动存档至 R2，发「继续」可续做 |

### 🧠 3. Agent 引擎与工具调优

控制 Web 端与 Telegram 端共用的 ReAct 循环步数、超时上限、上下文压缩与流式输出。

| 变量名 | 级别 | 默认值 | 用途说明 |
| :--- | :---: | :---: | :--- |
| `AGENT_MAX_STEPS` | 🟢 可选 | `6` | 单轮任务最大工具调用推理步数（上限 `12` 步；步数用尽自动触发无工具总结收尾） |
| `AGENT_TIMEOUT_MS` | 🟢 可选 | `240000` | Agent 单轮任务全局最大超时上限（毫秒，默认 4 分钟） |
| `WEB_AGENT_TIMEOUT_MS` | 🟢 可选 | `90000` | Web 网页端 Agent 单轮任务超时预算（毫秒，默认 90 秒，范围 `10000`~`240000`） |
| `AGENT_TOOL_TIMEOUT_MS` | 🟢 可选 | `30000` | 单个工具单次执行的超时上限（毫秒，默认 30 秒） |
| `AGENT_CONTEXT_BUDGET` | 🟢 可选 | `24000` | Agent 单轮上下文字符预算；超预算时自动折叠较早步数的工具原始输出并保留轻量步骤摘要 |
| `AGENT_STREAM_UPSTREAM` | 🟢 可选 | 开启流式 | 设为 `0` 可关闭 Agent 向上游大模型的流式请求，退回「整段生成完一次性返回」 |

### 🛡️ 4. 安全防护、限流与站点验证

用于保护 Web 端 `/api/chat` 免受盗刷，并支持第三方平台的域名所有权文件校验。

| 变量名 | 级别 | 默认值 | 用途说明 |
| :--- | :---: | :---: | :--- |
| `ACCESS_PASSWORD` | 🟠 推荐 | 免密访问 | Web 端访问口令；配置后前端请求 `/api/chat` 必须携带匹配的 `X-Access-Token` 请求头 |
| `RATE_LIMIT_PER_MIN` | 🟢 可选 | `60` | 单 IP 每分钟 `/api/chat` 请求次数上限（基于 Isolate LRU 滑动窗口）；设为 `0` 关闭限流 |
| `CORS_ORIGIN` | 🟢 可选 | `*` | 允许跨域调用的完整 Origin 白名单，逗号分隔（如 `https://chat.example.com`） |
| `VERIFY_FILE_PATH` | 🟢 可选 | — | 域名验证文件的访问路径（如 `/MP_verify_xxxx.txt`），GET 访问该路径时原样返回下方内容 |
| `VERIFY_FILE_CONTENT` | 🟢 可选 | 空字符串 | 配合 `VERIFY_FILE_PATH` 返回的纯文本验证内容 |

## 📱 Telegram 机器人交互指南

| 指令 / 交互方式 | 功能描述 |
| :--- | :--- |
| `/start` · `/model` | 弹出内联按钮菜单，一键切换当前会话使用的 AI 模型 |
| `/agent` | 切换 **🤖 Agent 模式**（默认开启，可调工具与知识库）与 **💬 普通对话模式** |
| `/clear` · `/new` | 清空当前会话的多轮对话历史及未完成的 Agent 断点存档 |
| `/memory` | 列出当前会话已保存的所有长期记忆条目 |
| `/forget <关键词>` | 删除包含指定关键词的长期记忆（也可直接说「忘掉关于…的记忆」） |
| `/kb` | 查看知识库总览（长期记忆条数统计 + R2 知识库文档清单） |
| `/help` | 查看完整功能说明、版本号（`v7.3.0`）及当前会话 `chatId` |
| **群聊智能触发** | 群组内发送 `@机器人 问题`、直接 **回复 (Reply)** 机器人的消息，或发送 `/命令` 即可触发并引用回复 |
| **图文与文档直传** | 直接发送图片触发 Vision 识图；发送 `.md`/`.txt`/`.csv`/`.json`/代码文件（≤512KB）可总结或要求存入知识库 |
| **发送「继续」** | 当复杂任务达到 55 秒预算暂停时，回复「继续」（群聊 `@机器人 继续`）即可从 R2 断点无缝接着执行 |

## 🛠️ 内置 18 项零密钥 Agent 工具箱

所有工具均**无需额外配置任何第三方 API Key**，开箱即用：

| 领域 | 工具名 | 核心能力与并发特性 | 可用端 | 触发示例 |
| :--- | :--- | :--- | :---: | :--- |
| **联网检索** | 🔍 `web_search` | DuckDuckGo 双端搜索，默认**自动并发预读前 2 条网页正文**（一步完成搜索+深读） | 🌐 Web + 🤖 TG | "今天有什么 AI 大新闻？" |
| **联网检索** | 📄 `web_fetch` | 结构化抓取网页正文（支持**最多 3 个 URL 并发抓取**、L1 缓存 `offset` 0ms 翻页与 Jina 回退） | 🌐 Web + 🤖 TG | "总结并对比这两篇文章：&lt;URL1&gt;,&lt;URL2&gt;" |
| **百科社区** | 🌐 `wiki_lookup` | 中英维基百科（Wikipedia）权威词条定义与摘要提取 | 🌐 Web + 🤖 TG | "查一下量子纠缠的维基百科定义" |
| **百科社区** | 🐙 `github_lookup` | GitHub 仓库详情（并发获取 Star、最新 Release 与 README）及热门开源项目搜索 | 🌐 Web + 🤖 TG | "查一下 cloudflare/workers-sdk 最新发版" |
| **百科社区** | 📑 `arxiv_search` | arXiv 学术论文检索（AI/CS/数学/物理），返回标题、作者、日期、摘要与 PDF 链接 | 🌐 Web + 🤖 TG | "搜一下 arXiv 上关于 DeepSeek R1 的论文" |
| **百科社区** | 📰 `hn_top` | Hacker News 实时首页科技热榜与高赞技术社区讨论检索 | 🌐 Web + 🤖 TG | "今天 Hacker News 上有什么热门话题？" |
| **实用计算** | 💱 `exchange_rate` | 160+ 法币实时汇率 + 主流加密货币（BTC/ETH/SOL 等）行情，支持**多币种并发换算** | 🌐 Web + 🤖 TG | "100 美元和 10000 日元换人民币是多少？BTC 多少钱" |
| **实用计算** | 🛰️ `net_lookup` | Cloudflare DoH 权威 DNS 解析（A/AAAA/CNAME/MX/TXT/NS）与公网 IP 归属地/ASN 诊断 | 🌐 Web + 🤖 TG | "查一下 openai.com 的 MX 记录和 1.1.1.1 归属" |
| **实用计算** | 🧮 `calculate` | 科学计算器（四则/乘方/三角/对数/统计函数，支持分号 `;` 分隔**多表达式批量计算**） | 🌐 Web + 🤖 TG | "帮我算 pow(1.08, 10) * 50000" |
| **实用计算** | 🧰 `toolkit` | 确定性工具箱：单位换算（含斤两/亩坪/MPG油耗）、SHA 哈希、Base64/URL 编解码、UUID、字数/Token 统计 | 🌐 Web + 🤖 TG | "35 MPG 换算百公里油耗；计算这段话的 SHA-256" |
| **实用计算** | 🕐 `get_time` | 指定时区当前时间、Unix 时间戳、两日期间隔天数/周数推算与日期加减计算 | 🌐 Web + 🤖 TG | "距离 2027-01-01 还有多少天？" |
| **实用计算** | 🌤️ `get_weather` | 城市实时天气与未来 3 天预报（Open-Meteo，支持逗号分隔**多城市并发查询**） | 🌐 Web + 🤖 TG | "查一下北京、上海、东京明天的天气" |
| **知识与记忆** | 📚 `list_docs` | 列出 R2 知识库中的所有文档标题、来源、大小与更新时间 | 🌐 Web + 🤖 TG | "知识库里有哪些文档？" |
| **知识与记忆** | 📖 `read_doc` | 按标题或关键词读取知识库文档（L1 缓存支持 `offset` 0ms 翻页与标题/词频加权检索） | 🌐 Web + 🤖 TG | "读取知识库里关于甲骨文 ARM 的文档" |
| **知识与记忆** | 🧠 `remember` | 保存关于用户的长期事实至 R2（同主题改口自动覆盖旧值，同步生成 `.md` 镜像） | 🤖 仅 TG | "记住，我养了一只猫叫汤圆" |
| **知识与记忆** | 🗑️ `forget_memory` | 按关键词自然语言删除长期记忆（同步清理 R2 JSON 索引与 `.md` 镜像） | 🤖 仅 TG | "忘掉关于旧住址的那条记忆" |
| **知识与记忆** | 💾 `save_doc` | 将长篇内容或上传文件保存为 R2 知识库 Markdown 文档（同来源链接自动去重） | 🤖 仅 TG | "把上面总结的内容存成知识库文档" |
| **知识与记忆** | 🗑️ `delete_doc` | 按标题或关键词从 R2 知识库中删除指定文档 | 🤖 仅 TG | "删除知识库文档《甲骨文ARM》" |

## 🗂️ 项目架构与 R2 存储布局

### 源码目录结构

```text
cloudflare-chat/
├── _worker.js                  # Worker 路由总入口（Web UI / API / Telegram / PWA / CORS）
├── wrangler.toml               # Wrangler 部署配置（R2 自动置备绑定 + keep_vars）
├── package.json                # 锁定 wrangler ^4.0.0（保障 Workers Builds 自动创建 R2）
└── src/
    ├── constants.js            # 版本号 (v7.3.0) 与公共响应头常量
    ├── channel.js              # 多通道解析、多 Key Round-Robin 轮询池与请求构建
    ├── auth.js                 # /api/chat 访问口令校验 (X-Access-Token)
    ├── rate-limit.js           # 单 IP 滑动窗口 LRU 限流器
    ├── web-agent.js            # Web 端 Agent SSE 流式桥接与心跳保活
    ├── tg-history.js           # Telegram 多轮历史管理（L1 内存 + L2 R2 持久化）
    ├── telegram/
    │   └── handler.js          # Telegram Webhook：签名校验、去重、群聊触发、多模态与命令
    ├── agent/
    │   ├── loop.js             # ReAct 主循环（并发预载、同轮去重、重试切 Key、总结收尾）
    │   ├── tools.js            # 18 项工具 Schema 定义与超时分发器
    │   ├── tools-web.js        # 联网搜索（含正文预读）与结构化网页抓取
    │   ├── tools-local.js      # 百科、GitHub、arXiv、HN、汇率、DNS、计算器、工具箱、天气、时间
    │   ├── prompt.js           # 动态系统提示词构建（注入长期记忆与知识库目录）
    │   ├── memory.js           # 长期记忆增删改查与同主题去重归一化
    │   ├── mode.js             # Agent 模式开关状态管理
    │   ├── resume.js           # 超长任务断点续做存档与恢复
    │   ├── dsml.js             # DeepSeek 等模型的 DSML 工具调用解析与流式剥离
    │   ├── limits.js           # 步数/超时上限与工具进度文案
    │   ├── stability.js        # 工具输出截断与上下文字符预算裁剪
    │   └── upstream.js         # 上游流式/非流式响应统一解析器
    ├── kb/
    │   ├── registry.js         # 知识库文档注册表 (kb/docs/registry.json) 读写与自愈重建
    │   └── doc-tools.js        # 文档保存、列表、L1 缓存分页读取与多关键词检索
    ├── store/
    │   ├── r2.js               # R2 存储底层读写封装
    │   └── kb.js               # 知识库 R2 路径映射与 Markdown 镜像生成
    ├── net/
    │   └── ssrf.js             # 网页抓取与 DNS 诊断的私网/内网地址 SSRF 防护
    ├── pwa/                    # PWA 清单 (manifest)、图标与 Service Worker 离线外壳
    └── ui/                     # Web 聊天前端模块化源码（状态、渲染、发送、设置、TTS、样式）
```

### R2 存储桶键值结构

```text
<R2 Bucket>
├── kb/
│   ├── agent_mem_<chatId>      # 长期记忆索引：JSON 数组 [{fact, ts, file}]（唯一可信源）
│   ├── mem/<chatId>/*.md       # 长期记忆镜像：每条记忆独立 Markdown 文件（供控制台直观浏览）
│   ├── docs/<标题>.md          # 知识库文档：save_doc 工具保存的长篇 Markdown（全局共享）
│   └── docs/registry.json      # 文档注册表：标题/来源/大小/更新时间索引（损坏时自动扫描重建）
├── tg_hist_<chatId>            # Telegram 会话多轮对话历史
├── tg_user_<chatId>            # Telegram 会话当前选中的模型 ID
├── agent_mode_<chatId>         # Telegram 会话 Agent 模式开关（1=开启，0=关闭）
├── tg_agent_<chatId>           # Telegram 超长任务断点续做状态存档（30 分钟有效）
└── tg_updates_dedup            # Telegram Webhook update_id 滚动去重窗口（10 分钟有效期）
```
# Cloudflare-Chat

基于 Cloudflare Workers 的多通道 AI 对话前端 + Telegram 机器人。入口为 `_worker.js`，模块化组织在 `./src/` 下，通过 `wrangler.toml` 声明式配置，支持连接 GitHub 仓库自动构建部署。当前版本 v7.0.0。

## 功能一览

- **多通道 AI 对话前端**：网页聊天 UI，支持多模型 / 多通道（OpenAI、通义千问、DeepSeek 等兼容 OpenAI 接口的通道），内置**可折叠工具调用轨迹胶囊**，PWA 可安装，支持离线打开外壳与按需重连探针
- **Telegram 机器人**：多轮对话（默认记 10 轮）、`/model` 内联按钮切换模型、**支持直接发送图片识图（Vision）及上传 `.md`/`.txt`/`.csv`/`.json`/代码文档直接分析或存入知识库**
- **Agent 模式**（默认开启，Web 与 Telegram 共用）：ReAct 循环自主规划，**13 个零密钥工具** —— 🔍 联网搜索、📄 结构化网页抓取（支持 `offset` 分页 + Jina 回退）、🌐 维基百科检索、💱 实时法币汇率与加密币价、🧮 科学计算器、🌤 天气、🕐 时间与日期推算、📚📖 知识库分页精读与多关键词相关性检索（两端可用）、🧠🗑️💾 长期记忆存取与清理 / 文档保存与删除（仅 Telegram）；Web 端查询优先知识库且只读
- **知识库 2.0**：长期记忆（`remember` / `forget_memory`）+ 知识库文档（`save_doc`，支持 10 万字分页 `read_doc` 与分词全文检索），全部持久化在 R2 的 `kb/` 独立文件夹
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

### 如何确认成功了

部署完成后，在构建日志中应当能看到类似：

```
The following bindings need to be provisioned:
Binding   Resource
env.R2    R2 Bucket

🌀 Creating new R2 bucket "cloudflare-chat-r2"...
✨ R2 provisioned 🎉
```

同时可以到 **R2 对象存储** 确认 bucket 已存在，并在 Worker 详情页的 **Bindings** 中看到 `R2`。

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

说明：

- `kb/mem/` 下的 md 是**只读镜像**，机器人只读 JSON 索引；手动在控制台改 md 不会生效，缺失的 md 会在下次加载时按索引自动重建。
- `kb/docs/` 是全局共享的知识库文档区，文件名由文档标题清洗得到（中文保留）。
- 从旧版本升级时，根目录的旧 `agent_mem_*` 会在首次读取时自动搬迁到 `kb/` 下，不丢数据。

### 未绑定 R2 时的行为

Telegram 机器人需要持久化（模型选择、对话历史、Agent 记忆与开关），**请务必绑定 R2**。未绑定时代码自动退化为纯内存：isolate 重启后机器人用户的模型选择、历史与记忆会丢失，但不会报错。网页端聊天不受影响（会话本来就只存浏览器本地）。

### 如果自动置备失败

构建日志若提示 R2 相关错误（构建环境 Wrangler 版本过旧不支持自动置备），去控制台 **R2** 页面手动创建一个 bucket（名字如 `cloudflare-chat-r2`），然后在 `wrangler.toml` 中取消注释并填入：

```toml
[[r2_buckets]]
binding = "R2"
bucket_name = "cloudflare-chat-r2"
```

---

# 第三步：配置环境变量（关键）

这个项目依赖环境变量来配置 API 和模型。部署成功后必须填入这些变量，否则页面会提示 API 错误。

1. 在 Cloudflare 中进入刚部署好的 Worker 项目页面。
2. 点击 **设置** (Settings) → **变量和机密** (Variables and Secrets)。
3. 在 **环境变量** 区域点击 **添加**。

> `wrangler.toml` 中已设置 `keep_vars = true`，控制台里手动添加的变量在后续部署时不会被清空。  
> 但注意：**添加或修改变量后必须重新部署一次**，新配置才会生效，新的模型列表也会随之出现在前端下拉框中。

### 多模型 / 多通道配置

按通道编号填写，多个模型用英文逗号 `,` 隔开，格式为 `模型ID:显示名称`。

- `API_URL_1` = 通道 1 的 API 地址
- `API_KEY_1` = 通道 1 的密钥
- `MODEL_1` = `模型:自定义模型名,模型:自定义模型名`

通道编号从 1 开始连续填写（最多支持 20 个通道），后端会自动合并所有通道的模型列表。

#### 通道 1（例如对接 OpenAI）

```
API_URL_1 = https://api.openai.com/v1/chat/completions
API_KEY_1 = sk-xxxxxx
MODEL_1   = gpt-4o:GPT-4o, gpt-4o-mini:GPT 4o Mini
```

#### 通道 2（例如对接阿里通义千问）

```
API_URL_2 = https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
API_KEY_2 = sk-yyyyyy
MODEL_2   = qwen-plus:通义千问 Plus, qwen-max:通义千问 Max
```

### 另一种方式：单通道精简配置

如果只用一个通道，也可以直接用不带编号的变量名：

```
API_URL = https://api.openai.com/v1/chat/completions
API_KEY = sk-xxxxxx
MODEL   = gpt-4o:GPT-4o, deepseek-ai/DeepSeek-R1:深度思考 R1
```

> 优先级说明：`API_CONFIG`（JSON 格式）> 带编号的 `API_URL_1/API_KEY_1/MODEL_1` 系列 > 不带编号的 `API_URL/API_KEY/MODEL`。同时存在时以优先级高的为准。

> 代码中**不内置任何默认模型**。没有配置环境变量时，前端下拉框会显示「未配置模型，请检查环境变量」，调用接口会返回明确的错误提示，而不会出现一个选了就报错的幽灵模型。

---

### 访问口令（可选，防止接口被白嫖）

如果 Worker 部署在公开域名上，建议设置访问口令。在 **设置 → 变量和机密** 中添加：

```
ACCESS_PASSWORD = 你自己设定的一串口令
```

添加后：

- `/api/chat` 会要求请求头 `X-Access-Token` 与该值一致，否则返回 `401`；
- 前端在**左下角设置 → 访问口令**中填入同样的口令即可正常使用，口令只保存在本机浏览器，不会上传到服务端；
- 首次发送时若口令错误或未填写，界面会提示并自动弹出设置面板；已输入的内容会保留在输入框里，填完口令直接重发即可。

**不添加 `ACCESS_PASSWORD` 时接口保持开放**，行为与从前完全一致 —— 这个校验是可选的，不会影响已有部署。

> 口令校验只保护 `/api/chat`。`/` 页面本身仍是公开的（否则界面无法加载），但即使有人打开页面，没有口令也无法发起对话。Telegram 机器人走的是独立的 webhook 通道，不受此口令影响。

---

# 第四步：启用 Telegram 机器人（可选）

1. 在 @BotFather 处创建机器人，拿到 Bot Token。
2. 在 Worker 的 **设置 → 变量和机密** 中添加 `TG_BOT_TOKEN`。
3. （强烈推荐）再添加 `TG_WEBHOOK_SECRET`，填一串自己生成的随机字符串（例如 `openssl rand -hex 24`）。配置后，Worker 只接受携带正确 `X-Telegram-Bot-Api-Secret-Token` 请求头的 webhook 调用，可防止他人伪造 Telegram 请求刷你的 API 额度。
4. 重新部署，然后设置 Webhook（把 `<SECRET>` 换成上一步的值；若没配置 `TG_WEBHOOK_SECRET`，去掉 `&secret_token=` 部分即可）：

```
https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=https://<你的Worker域名>/tg-webhook&secret_token=<SECRET>
```

配置完成后，在 Telegram 中向机器人发送 `/start` 或 `/model` 即可通过内联按钮切换模型。用户的模型选择会通过第二步自动创建的 R2 存储桶持久化保存。

### 多轮对话与多模态文件直传（v7.0.0 新增）

- **多轮对话**：机器人默认记住最近 **10 轮**对话（可通过环境变量 `TG_HISTORY_ROUNDS` 调整，最大 30；另有 12000 字符的总预算，超限自动丢弃最旧的消息）。历史存 R2，机器人重启不丢失。发送 `/clear` 可清空当前上下文、开启新话题。
- **直接上传文本文件**：向机器人直接发送 `.md`、`.txt`、`.csv`、`.json`、`.log` 或常见代码文件（最大 512KB），机器人会自动读取文本内容，可配合文件说明让它总结，或直接说「把这个文件存进知识库」。
- **发送图片多模态识图**：直接发送图片给机器人（选用支持视觉的模型如 `gpt-4o` / `qwen-vl`），即可进行识图问答、OCR 提取或图表分析。

### Agent 模式（默认开启）

机器人不再是简单的问答机，而是一个 **Agent**：以 LLM 为核心推理引擎，能自主规划、多步调用工具、长期记住你。

**可用工具**（全部零密钥、零成本，共 13 项）。**权限分域**：知识库写入与清理类工具（`remember` / `forget_memory` / `save_doc` / `delete_doc`）**仅 Telegram 端可用**——Web 端对知识库只读（保留 `list_docs` / `read_doc`），访客无法污染全局知识库：

| 工具              | 能力                                                                 | 可用端        | 示例触发                        |
| --------------- | ------------------------------------------------------------------ | ---------- | --------------------------- |
| `web_search`    | 联网搜索最新信息（DuckDuckGo HTML + Lite 双端回退）                              | 两端         | "今天有什么 AI 大新闻？"             |
| `web_fetch`     | 结构化抓取网页正文（保留标题/代码块/表格/列表，支持 `offset` 翻页 + Jina 免密钥回退）             | 两端         | "总结一下这篇文章：<链接>"             |
| `wiki_lookup`   | 中英维基百科（Wikipedia）权威词条检索与摘要提取                                       | 两端         | "查一下量子纠缠的维基百科定义"            |
| `exchange_rate` | 实时法币汇率换算（160+ 币种）+ 主流加密货币（BTC/ETH/SOL 等）实时价格与 24h 涨跌               | 两端         | "10000 日元换算成人民币是多少？BTC 现在多少钱" |
| `calculate`     | 科学计算器（四则/乘方/括号 + `sqrt`/`log`/`sin`/`cos`/`round`/`pow`/`pi`/`e`） | 两端         | "帮我算 pow(1.08, 10) * 50000" |
| `get_time`      | 当前时间（可指定时区）+ 日期差推算（`target_date`）+ 日期加减天数推算（`add_days`）           | 两端         | "距离 2027-01-01 还有多少天？"      |
| `get_weather`   | 城市天气 + 今明两天预报（Open-Meteo）                                          | 两端         | "北京明天适合跑步吗"                 |
| `remember`      | 长期记住关于你的事实（R2 持久化，不限条数；同主题改口自动覆盖旧值）                                | 仅 Telegram | "记住，我养了一只猫叫汤圆"              |
| `forget_memory` | 按关键词自然语言删除长期记忆（同步清理 R2 `.md` 镜像）                                   | 仅 Telegram | "忘掉关于旧住址的那条记忆"              |
| `save_doc`      | 把长篇内容保存为知识库文档（真实写入 R2 `kb/docs/`，同链接自动去重）                          | 仅 Telegram | "把这篇文章存成知识库文档"              |
| `list_docs`     | 列出知识库文档标题                                                          | 两端         | （自动调用）                      |
| `read_doc`      | 按标题或关键词读取知识库文档（支持 `offset` 分页续读万字长文 + 多关键词分词全文相关性排序检索）             | 两端         | （自动调用）                      |
| `delete_doc`    | 删除一篇知识库文档                                                          | 仅 Telegram | "删除知识库文档《甲骨文ARM》"           |

**工作方式**：ReAct 循环 —— 模型先判断意图，简单问题直接回答；需要时自主规划多步（比如先搜索再抓取原文、先查汇率再计算），最多 6 步，工具结果回填后综合作答，绝不编造。Web 端执行完工具调用后，会在回复气泡顶部自动生成可折叠的**「🛠️ 已调用 N 项工具」轨迹胶囊**，点击即可展开查看每一步工具动作与耗时。

**命令**：

- `/agent` —— 在 Agent / 普通对话模式间切换（选择保存在 R2，默认 Agent 开启）
- `/model` —— 切换模型；`/clear` —— 清空上下文
- `/memory` —— 查看长期记忆；`/forget 关键词` —— 删除记忆；`/kb` —— 知识库总览（文档列表 + 记忆统计）；`/help` —— 命令列表

---

# 第五步：语音朗读回复（已内置，无需配置）

前端已内置「把 AI 回复读出来」的能力，基于浏览器原生 **Web Speech API**：

- **单条朗读**：每条 AI 回复下方有一个「朗读」按钮，点击即朗读该条内容，再点一次（按钮变为「停止」）即中止。
- **自动朗读**：左下角侧边栏的**喇叭图标**是一个开关，开启后每次 AI 回复生成完毕会自动朗读，开关状态保存在浏览器本地。
- **智能清洗**：朗读前会自动把 Markdown 转成适合听的纯文本 —— 代码块替换为「（代码块已省略）」、行内代码保留文字、链接只念标题、表格与分隔线去掉，不会念出一堆符号。
- **语言自动识别**：含中日韩字符时使用 `zh-CN`，否则使用 `en-US`。
- **零成本、零密钥**：使用操作系统自带的语音合成，不调用任何云端 TTS 接口，不产生费用，也不需要额外环境变量。

---

# 第六步：PWA（已内置，无需配置）

前端已具备完整的 PWA 能力，可以像原生 App 一样安装到桌面 / 主屏幕，并支持离线打开。

| 能力               | 实现                                                                        |
| ---------------- | ------------------------------------------------------------------------- |
| Web App Manifest | `GET /manifest.webmanifest`，`display: standalone`，含 192/512 + maskable 图标 |
| Service Worker   | `GET /sw.js`，挂在根路径，`Service-Worker-Allowed: /`、`Cache-Control: no-cache`  |
| 图标               | `GET /icon-192.png`、`/icon-512.png`、`/icon-maskable-512.png`              |
| 健康探针             | `GET /healthz`，离线状态时按需轮询判断服务端是否恢复可达                                      |
| 安装入口             | 侧边栏左下角的下载图标，浏览器判定可安装后自动出现                                                 |
| 离线提示             | 顶部橙色横幅，断网时滑入，恢复后自动消失                                                      |

---

# 安全提示

- **`/api/chat` 支持访问口令**：配置环境变量 `ACCESS_PASSWORD` 即生效，未配置则保持开放。服务端比较采用全定长实现（包含不同长度输入），消除口令长度侧信道。
- **`/api/chat` 按 IP 限流**：默认每 IP 每分钟 60 次（`RATE_LIMIT_PER_MIN` 可调，设 0 关闭），基于 LRU 顺序 $O(N)$ 淘汰。
- **`/tg-webhook` 来源校验**：配置 `TG_WEBHOOK_SECRET` 后，只接受 `setWebhook` 时传入相同 `secret_token` 的请求。
- **Telegram 聊天白名单**：配置 `TG_ALLOWED_CHAT_IDS`（逗号分隔的 chat id，只填你自己的）后，机器人只响应名单内的聊天，其他一律静默忽略。
- **Agent `web_fetch` 的 SSRF 防护**：拦截内网 / 本机回环 / 链路本地（169.254.x）/ 保留与组播网段 / 云元数据地址及 `localhost` 等危险主机名，且逐跳校验重定向目标。
- **AI 回复经 XSS 清洗**：前端所有 AI 生成内容先经 Markdown 渲染，再过 DOMPurify 白名单清洗后才插入页面。
- **CORS 默认 `*`，可用 `CORS_ORIGIN` 收紧**：配置环境变量 `CORS_ORIGIN`（如 `https://chat.example.com`，逗号分隔可多个）后，只回显名单内的 Origin。

---

# 附：环境变量一览

| 变量                      | 说明                                                                              | 默认值            |
| ----------------------- | ------------------------------------------------------------------------------- | -------------- |
| `TG_WEBHOOK_SECRET`     | Telegram webhook 校验密钥，见第四步                                                      | 未配置=不校验        |
| `TG_ALLOWED_CHAT_IDS`   | Telegram 聊天白名单（逗号分隔），只响应名单内的聊天                                                  | 未配置=开放         |
| `TG_HISTORY_ROUNDS`     | 机器人记住的最近对话轮数（最大 30）                                                             | `10`           |
| `MAX_TOKENS`            | `/api/chat` 与机器人共用的 `max_tokens`（上限 32000）                                      | `4096`         |
| `RATE_LIMIT_PER_MIN`    | 每 IP 每分钟 `/api/chat` 限额，`0` 关闭                                                  | `60`           |
| `AGENT_MAX_STEPS`       | Agent 单轮任务最大推理步数（上限 12）                                                         | `6`            |
| `AGENT_TIMEOUT_MS`      | Agent 单轮任务总超时（毫秒）                                                               | `240000`（4 分钟） |
| `AGENT_TOOL_TIMEOUT_MS` | 单个工具最长执行时间（毫秒）                                                                  | `30000`（30 秒）  |
| `AGENT_CONTEXT_BUDGET`  | Agent 单轮任务上下文字符预算，超预算裁剪本轮旧 tool 轮次                                              | `24000`        |
| `WEB_AGENT_TIMEOUT_MS`  | 网页端 Agent 单轮任务总超时（毫秒），10 秒 ~ 240 秒                                              | `90000`（90 秒）  |
| `AGENT_STREAM_UPSTREAM` | 设为 `0` 可关闭 Agent 真流式，退回「等整段生成完再显示」                                              | 未配置=开启流式       |
| `TG_API_TIMEOUT_MS`     | Telegram Bot API 单次调用超时（毫秒）                                                     | `15000`（15 秒）  |
| `TG_WEBHOOK_BUDGET_MS`  | webhook 内 Agent 单轮预算（毫秒），10 秒 ~ 240 秒                                           | `55000`（55 秒）  |
| `CORS_ORIGIN`           | 跨域白名单（逗号分隔的完整 Origin，如 `https://chat.example.com`）；配置后 CORS 只放行名单内来源            | 未配置=`*`        |

---

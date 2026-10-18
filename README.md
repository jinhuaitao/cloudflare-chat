# ⚡ Cloudflare-Chat `v7.4.0`

> **基于 Cloudflare Workers + R2 的零依赖多通道 AI 对话前端 + 全能 Telegram 机器人 + 微信 ClawBot (iLink) 官方通道**  
> `🌐 流式 Web + PWA` · `🤖 Telegram 私聊/群聊` · `🟢 微信 ClawBot 安全绑定` · `🧠 18 项零密钥 Agent 工具` · `📚 R2 知识库` · `🔄 多 Key 轮询容灾`

## ✨ 核心特性

| 模块 | 核心能力 |
| :--- | :--- |
| 💬 **Web 对话前端** | 兼容 OpenAI / DeepSeek / 通义千问及文生图接口；支持 **20 组通道**、**多 Key 轮询切流**、工具调用胶囊、原生 TTS 朗读与 PWA 离线安装 |
| 🤖 **Telegram 机器人** | 支持私聊与**群聊智能触发**（`@提及` / 引用回复 / `/命令`）、**Vision 发图识图**、上传文档/代码直接分析及超时 **「继续」断点续做** |
| 🟢 **微信 ClawBot 通道** | 原生实现腾讯官方 **iLink Bot API (`@tencent-weixin/openclaw-weixin` v2.4.10)** 协议；内置 **四重防盗绑安全机制**、Cron 定时长轮询 + Webhook + 主动推送、原生「对方正在输入…」指示器、**语音自动转文字对话**、**AES-128-ECB 发图识图**与文件分析 |
| 🧠 **极速 ReAct Agent** | Web、Telegram 与微信三端共用引擎；内置 **18 项零密钥工具**，支持 DSML 流式防闪烁、L1 缓存、同轮调用去重与搜索自动预读网页正文 |
| 📚 **R2 知识库 2.0+** | 长期记忆（同主题自动覆盖）+ 文档库（`offset` 0ms 翻页与多词加权检索），全量持久化于 R2 `kb/`；**Web 只读、Telegram 与微信 ClawBot 读写** |

## 🛡️ 微信 ClawBot 四重防盗绑安全机制

针对「公开网址是否会被路人随意扫码绑定或覆盖」的安全隐患，本版内置了 4 层纵深防护：

1. **强制管理员密钥校验（拒绝无密裸奔绑定）**：服务端必须配置 `WX_ADMIN_SECRET`（或 `ACCESS_PASSWORD`）并在网页端输入验证通过后，才允许请求二维码或解绑；若未配置任何密钥，网页端扫码绑定接口将**自动锁死拒绝**，路人知道网址也无法扫码。
2. **管理员与普通访客权限分离（`WX_ADMIN_SECRET`）**：如果你将网页端分享给朋友使用（共享 `ACCESS_PASSWORD` 或免密开放聊天），只需单独配置 `WX_ADMIN_SECRET`，即可让普通访客正常使用网页对话，但只有知道 `WX_ADMIN_SECRET` 的管理员能查看/绑定/解绑微信通道。
3. **一次绑定防覆盖锁（Bind-Once Lock）**：一旦你扫码绑定成功（或通过环境变量 `WX_BOT_TOKEN` 固定绑定），通道立即进入加锁状态，禁止直接生成新二维码覆盖，彻底杜绝被他人顶号。
4. **扫码人身份自动锁定（Owner Auto-Lock）**：扫码确认时，系统自动记录你的微信 `ilink_user_id` 为唯一合法主人（亦可手动配置 `WX_ALLOWED_USERS` 白名单），非本人微信号无法触发对话或污染知识库。

## 🚀 快速部署与通道绑定

##### 方式一

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jinhuaitao/cloudflare-chat)

##### 方式二

1. **导入 Git 部署**：Cloudflare 控制台 → **Workers & Pages** → **连接到 Git** 选择本仓库（构建命令留空，部署命令 `npx wrangler deploy`）。
   > 💡 `wrangler.toml` 已开启 **R2 自动置备**、**Cron 定时触发器 (`* * * * *`)** 与 `keep_vars = true`，首次部署会自动创建并绑定 R2 存储桶。
2. **配置模型通道**：进入 Worker **设置 → 变量和机密**，添加至少一组模型变量（多 Key 用英文逗号分隔，自动轮询）：
   ```ini
   API_URL_1 = https://api.openai.com/v1/chat/completions
   API_KEY_1 = sk-key1,sk-key2
   MODEL_1   = gpt-4o:GPT-4o,deepseek-chat:DeepSeek V3
   ```
3. **绑定微信 ClawBot 通道（可选）**：
   - 在 Worker 环境变量中设置 `WX_ADMIN_SECRET`（或 `ACCESS_PASSWORD`）；
   - 在手机微信中开启 **「我 → 设置 → 插件 → ClawBot」**；
   - 打开部署好的 Web 网页端，点击左下角侧边栏的 **🟢 微信气泡图标** → 输入管理员密钥点击 **「验证」** → 点击 **「📱 扫码绑定微信 ClawBot」**；
   - 用手机微信扫描二维码并确认连接，凭证与你本人的 `ilink_user_id` 将自动加密锁定至 R2（也可直接在环境变量中固定配置 `WX_BOT_TOKEN`）。
4. **绑定 Telegram 机器人（可选）**：向 `@BotFather` 获取 Token，配置 `TG_BOT_TOKEN` 与随机密钥 `TG_WEBHOOK_SECRET` 后重部署，浏览器访问以下地址完成绑定：
   ```text
   https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook?url=https://<你的Worker域名>/tg-webhook&secret_token=<TG_WEBHOOK_SECRET>
   ```

## ⚙️ 环境变量分类速查

> 标记说明：`🔴 必填` 核心运行必需 · `🟠 推荐` 生产环境建议配置 · `🟢 可选` 不填即用默认值 · `🔵 自动` 系统自动探测

### 🔌 1. AI 模型与通道配置

按 `API_CONFIG` ➔ `API_URL_1..20` ➔ `API_URL` 优先级加载；单通道多 Key 自动开启 Round-Robin 负载均衡与 `429/5xx` 故障切流。

| 变量名 | 级别 | 默认值 | 说明与示例 |
| :--- | :---: | :---: | :--- |
| `API_URL_1` ~ `API_URL_20` | 🔴 必填 | — | 通道 `1~20` 接口地址（如 `https://.../v1/chat/completions` 或文生图 `.../images/generations`） |
| `API_KEY_1` ~ `API_KEY_20` | 🔴 必填 | — | 对应通道密钥，支持英文逗号分隔多个 Key（例：`sk-a,sk-b`） |
| `MODEL_1` ~ `MODEL_20` | 🔴 必填 | — | 模型列表，格式 `模型ID:显示名`，逗号分隔（例：`gpt-4o:GPT-4o,qwen-max:千问Max`） |
| `API_URL` / `API_KEY` / `MODEL` | 🟢 可选 | — | 单通道极简配置（未配置编号通道或 `API_CONFIG` 时作为兜底生效） |
| `API_CONFIG` | 🟢 可选 | — | JSON 聚合通道配置：`[{"url":"...","keys":["sk-1"],"models":["gpt-4o:GPT-4o"]}]` |
| `MAX_TOKENS` | 🟢 可选 | `4096` | 单次回复最大 Token 数（Web / Telegram / 微信共用，上限 `32000`） |

### 🟢 2. 微信 ClawBot (iLink) 通道配置

| 变量名 | 级别 | 默认值 | 说明 |
| :--- | :---: | :---: | :--- |
| `WX_ADMIN_SECRET` | 🔴 强烈推荐 | 回退 `ACCESS_PASSWORD` | **微信通道专属管理员密钥**：用于解锁网页端扫码绑定与解绑，与普通网页访客权限隔离 |
| `WX_BOT_TOKEN` | 🔵 自动 / 可选 | Web 扫码自动保存 | 微信 iLink `bot_token`（若填入环境变量则永久锁定，网页端无法解绑或覆盖） |
| `WX_ALLOWED_USERS` | 🟠 推荐 | 自动锁定扫码人 | 允许对话的微信用户 `ilink_user_id` 白名单，逗号分隔（不填则自动仅允许扫码绑定人本人） |
| `WX_WEBHOOK_SECRET` | 🟢 可选 | 不校验 | 当使用第三方 iLink 网关推送至 `/wx-webhook` 时的校验密钥 |
| `WX_POLL_BUDGET_MS` | 🟢 可选 | `52000` | Cron 定时触发单次长轮询窗口最大运行毫秒数（默认 52 秒） |
| `WX_WEBHOOK_BUDGET_MS` | 🟢 可选 | `55000` | 微信单轮 Agent 运行预算（毫秒）；超时自动存档，微信发「继续」即可续做 |
| `WX_BASE_URL` | 🟢 可选 | `https://ilinkai.weixin.qq.com` | 微信 iLink 网关地址（扫码后会自动使用服务端下发的专属 `baseurl`） |
| `WX_CHANNEL_VERSION` | 🟢 可选 | `2.4.10` | 模拟 `@tencent-weixin/openclaw-weixin` 协议版本号（自动计算 `iLink-App-ClientVersion`） |

### 🤖 3. Telegram 机器人配置

| 变量名 | 级别 | 默认值 | 说明 |
| :--- | :---: | :---: | :--- |
| `TG_BOT_TOKEN` | 🔴 必填 | — | `@BotFather` 机器人 Token（启用 Telegram 机器人必填） |
| `TG_WEBHOOK_SECRET` | 🟠 推荐 | 不校验 | Webhook 签名校验密钥（可用 `openssl rand -hex 24` 生成，防伪造请求） |
| `TG_ALLOWED_CHAT_IDS` | 🟠 推荐 | 全部放行 | 允许使用的私聊 `user_id` 或群组 `chat_id` 白名单，逗号分隔（发 `/help` 可查当前 ID） |
| `TG_HISTORY_ROUNDS` | 🟢 可选 | `10` | 多轮对话保留轮数（上限 `30` 轮，Telegram 与微信共用，受 12,000 字符上下文安全预算保护） |
| `TG_BOT_USERNAME` | 🔵 自动 | `getMe` 探测 | 机器人用户名（不含 `@`），用于群聊识别 `@提及`，默认自动获取无需手填 |
| `TG_GROUP_REPLY_ALL` | 🟢 可选 | 仅提及响应 | 群聊模式：默认仅响应 `@机器人`、引用回复与 `/命令`；设为 `1` 则群内每条消息均回复 |
| `TG_API_TIMEOUT_MS` | 🟢 可选 | `15000` | Telegram Bot API 单次请求超时毫秒数（15 秒） |
| `TG_WEBHOOK_BUDGET_MS` | 🟢 可选 | `55000` | Webhook 单轮 Agent 运行预算（`10000`~`240000` 毫秒）；超时自动存档，发「继续」续做 |

### 🧠 4. Agent 引擎与工具配置

| 变量名 | 级别 | 默认值 | 说明 |
| :--- | :---: | :---: | :--- |
| `AGENT_MAX_STEPS` | 🟢 可选 | `6` | 单轮任务最大工具推理步数（上限 `12` 步，耗尽后自动汇总收尾） |
| `AGENT_TIMEOUT_MS` | 🟢 可选 | `240000` | Agent 单轮任务全局超时上限（毫秒，默认 4 分钟） |
| `WEB_AGENT_TIMEOUT_MS` | 🟢 可选 | `90000` | Web 网页端 Agent 单轮超时预算（毫秒，默认 90 秒，范围 `10000`~`240000`） |
| `AGENT_TOOL_TIMEOUT_MS` | 🟢 可选 | `30000` | 单个工具单次执行超时上限（毫秒，默认 30 秒） |
| `AGENT_CONTEXT_BUDGET` | 🟢 可选 | `24000` | 单轮上下文字符预算，超出时自动折叠早期工具输出并保留步骤摘要 |
| `AGENT_STREAM_UPSTREAM` | 🟢 可选 | 开启流式 | 设为 `0` 可关闭 Agent 上游流式输出，退回整段生成后一次性返回 |

### 🛡️ 5. 安全、限流与站点验证

| 变量名 | 级别 | 默认值 | 说明 |
| :--- | :---: | :---: | :--- |
| `ACCESS_PASSWORD` | 🟠 推荐 | 免密访问 | Web 端 `/api/chat` 访问口令（前端通过 `X-Access-Token` 校验） |
| `RATE_LIMIT_PER_MIN` | 🟢 可选 | `60` | 单 IP 每分钟 `/api/chat` 请求上限；设为 `0` 关闭限流 |
| `CORS_ORIGIN` | 🟢 可选 | `*` | 跨域白名单，逗号分隔完整域名（如 `https://chat.example.com`） |
| `VERIFY_FILE_PATH` / `VERIFY_FILE_CONTENT` | 🟢 可选 | — | 域名所有权验证路径（如 `/MP_verify_xxx.txt`）与返回的纯文本内容 |

## 📱 Telegram & 微信 ClawBot 交互与 18 项零密钥工具

### 机器人常用指令（Telegram & 微信 ClawBot 通用）

| 指令 / 操作 | 功能说明 |
| :--- | :--- |
| `/start` · `/model` | 查看或切换当前会话 AI 模型（Telegram 弹出内联按钮；微信展示编号列表，发 `/model 序号` 或 `/model 模型名` 即可切换） |
| `/agent` | 切换 **🤖 Agent 模式**（默认开启）与 **💬 普通对话模式** |
| `/clear` · `/new` | 清空当前会话多轮上下文与未完成的断点存档 |
| `/memory` · `/forget <词>` | 查看全部长期记忆 / 删除包含指定关键词的记忆（或直接说「记住…」「忘掉…」） |
| `/kb` · `/help` | 查看知识库总览（记忆 + 文档列表） / 查看帮助、版本号与当前会话 ID |
| `/wxlogin` · `/wxstatus` · `/wxunbind` | **（仅 Telegram 私聊管理员）** 直接在 Telegram 中获取微信 ClawBot 扫码绑定链接、查看状态或解绑 |
| **语音 / 传图 / 续做** | 微信支持直接发语音对话；两端均支持直接发图识图、传 `.md/.txt/.csv/.json`/代码文件分析；长任务暂停后发 **「继续」** 续做 |

### 内置 18 项零密钥 Agent 工具箱

| 分类 | 内置工具 | 能力摘要（全部免额外 API Key） | 可用范围 |
| :--- | :--- | :--- | :---: |
| 🔍 **联网与抓取** | `web_search` · `web_fetch` | DuckDuckGo 双端搜索（自动并发预读前 2 条网页正文）；结构化抓取网页（支持 3 URL 并发、`offset` 0ms 翻页与 Jina 回退） | 🌐 Web + 🤖 TG + 🟢 微信 |
| 🌐 **百科与社区** | `wiki_lookup` · `github_lookup` · `arxiv_search` · `hn_top` | 中英维基百科词条；GitHub 仓库 Star/Release/README 检索；arXiv 论文检索；Hacker News 实时热榜与高赞讨论 | 🌐 Web + 🤖 TG + 🟢 微信 |
| 🧮 **计算与工具** | `calculate` · `toolkit` · `get_time` · `get_weather` · `exchange_rate` · `net_lookup` | 科学计算器（支持 `;` 批量计算）；单位换算/SHA哈希/Base64/UUID/Token 统计；时区与日期差推算；多城市天气预报；160+ 法币与加密货币汇率；DoH DNS 与 IP 归属诊断 | 🌐 Web + 🤖 TG + 🟢 微信 |
| 📖 **知识库检索** | `list_docs` · `read_doc` | 列出知识库文档清单；按标题或多关键词加权检索文档正文（L1 内存缓存支持 `offset` 0ms 翻页） | 🌐 Web + 🤖 TG + 🟢 微信 |
| 💾 **记忆与写入** | `remember` · `forget_memory` · `save_doc` · `delete_doc` | 长期记忆存取与同主题自动覆盖（同步生成 `.md` 镜像）；将长文或上传文件保存为知识库文档、按标题删除文档 | 🤖 TG + 🟢 微信 |

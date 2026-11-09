# ⚡ Cloudflare-Chat `v7.14.0`

> **基于 Cloudflare Workers + R2 的零依赖多通道 AI 对话前端 + 全能 Telegram 机器人 + 微信 ClawBot (iLink) 官方通道**  
> `🌐 流式 Web + PWA` · `🤖 Telegram 私聊/群聊` · `🟢 微信 ClawBot 安全绑定` · `🧠 三层记忆（L1/L2/L3）` · `🛠 19 项零密钥 Agent 工具` · `📚 R2 知识库（写入模式/版本快照/标签检索）` · `🔄 多 Key 轮询容灾`

## ✨ 核心特性

| 模块 | 核心能力 |
| :--- | :--- |
| 💬 **Web 对话前端** | 兼容 OpenAI / DeepSeek / 通义千问及文生图接口；支持 **20 组通道**、**多 Key 轮询切流**、工具调用胶囊、原生 TTS 朗读与 PWA 离线安装；侧栏 **📚 知识库只读面板**（`GET /api/kb/list`，顺带核对索引与实际文件） |
| 🤖 **Telegram 机器人** | 支持私聊与**群聊智能触发**（`@提及` / 引用回复 / `/命令`）、**Vision 发图识图**、上传文档/代码直接分析及超时 **「继续」断点续做** |
| 🟢 **微信 ClawBot 通道** | 原生实现腾讯官方 **iLink Bot API (`@tencent-weixin/openclaw-weixin` v2.4.10)** 协议；内置 **四重防盗绑安全机制**、Cron 定时长轮询 + Webhook + 主动推送、原生「对方正在输入…」指示器、**语音自动转文字对话**、**AES-128-ECB 发图识图**与文件分析 |
| 🧠 **极速 ReAct Agent** | Web、Telegram 与微信三端共用引擎；内置 **19 项零密钥工具**，支持 DSML 流式防闪烁、L1 缓存、同轮调用去重与搜索自动预读网页正文 |
| 🧠 **三层记忆** | **L1 工作记忆**（会话要点自动记录、同话题合并、超 12 条沉淀）· **L2 长期记忆**（事实/偏好/身份/任务，带权重与命中次数、45 天半衰期、满 240 条按衰减分淘汰）· **L3 归档**（承接 L1 溢出与 L2 淘汰，可检索）；冲突按 `L1 > L2 > L3` 取值 |
| 📚 **R2 知识库 2.0+** | 文档库（`offset` 0ms 翻页 + 全库多词检索，4 秒预算与结果缓存）；**写入模式**（`create`/`overwrite`/`append`/`prepend`）、**覆盖前自动版本快照**（保留 3 份）、**内容指纹去重**、**错误页拒收**、**标签检索**；全量持久化于 R2 `kb/`；**Web 只读、Telegram 与微信 ClawBot 读写** |

## 🧠 三层记忆架构

单层「长期记忆」有两个绕不开的问题：历史超过 `TG_HISTORY_ROUNDS`（默认 10 轮）就被裁掉，模型彻底忘了前面聊过什么；长期事实只有一个不断膨胀的数组，没有权重也没有淘汰。因此拆成三层，各管一段：

| 层 | 名字 | 生命周期 | 存什么 | 容量与淘汰 |
| :--- | :--- | :--- | :--- | :--- |
| **L1** | 工作记忆 Working | 会话级，7 天无活动自动过期 | 每轮问答压成一条「问 → 答」要点；本会话固定的约束（`pin`） | 12 条话题 + 6 条固定；**溢出最旧的一条沉淀进 L3**，不丢弃 |
| **L2** | 长期记忆 Long-term | 跨会话持久 | 用户事实 / 偏好 / 身份 / 长期任务，带 `weight`(1-5) 与 `hits` | 240 条；满时按 `权重 × 时间衰减(45 天半衰期) + 命中加成` 淘汰最弱的，**淘汰项进 L3** |
| **L3** | 归档 Archive | 持久，可检索 | L1 溢出的会话要点、L2 淘汰的事实 | 400 条，超出丢最旧（归档允许丢，但比彻底消失好） |

**三层如何进入提示词**：L1 1600 字符、L2 3000 字符、L3 900 字符，各自独立预算互不挤占；L2 按「相关性优先、衰减分次序」挑选，与提问无关但权重高的画像类记忆仍会排在后面一起注入。三层冲突时明确按 `L1（本会话最新）> L2 > L3` 取值，并要求模型在回答里说明「与之前记录不同，已按你最新说法」。

**存储布局**（全部在 R2 `kb/` 下，控制台可直接浏览）：

```text
kb/mem3/work/<chatId>.json      L1 工作记忆：{items:[{t,g,ts}], pins:[{text,ts}]}
kb/mem3/long/<chatId>.json      L2 长期记忆：{fact,ts,kind,weight,hits,lastUsed,file}
kb/mem3/archive/<chatId>.json   L3 归档：{type:'session'|'memory', text, ts}
kb/mem/<chatId>/*.md            L2 每条记忆的 Markdown 镜像（frontmatter 含 kind/weight）
kb/agent_mem_<chatId>           旧版长期记忆键（自动读取并迁移到 mem3/long，旧键保留可回滚）
kb/docs/*.md                    知识库文档（用户主动保存的长文，与归档互不干扰）
```

**检索与操作**：直接问「你还记得我什么」「之前那个方案第三点是什么」，模型会调 `memory` 工具跨层检索；`/memory` 看三层视图；`/forget 关键词` 删除；`/clear` 只清 L1。Web 端可读 L1、可检索三层，但不能写入（`pin` / `remember` / `save_doc` 仍只在机器人端开放）。

**为什么摘要不用 LLM 生成**：一轮一次额外调用会让延迟与费用翻倍，而 Agent 本身已经在 90~240 秒的预算里跑。这里用确定性抽取（去 Markdown → 取首句 → 60/100 字截断 → 2-gram 相似度合并同话题），0ms、0 成本、可回归测试。

## 🗂️ 知识库保存链路

「保存到知识库」如果只有一条路，很容易变成：同名标题**静默覆盖**、内容超长直接截断、没有任何回滚余地。这条链路现在做了补齐，并且两端共用：

**四条入口，同一套落盘逻辑**

| 入口 | 触发方式 | 行为 |
| :--- | :--- | :--- |
| ① 确定性入库 | Telegram 上传文件并附言「存进知识库 / 保存 / 入库」 | 不赌模型会不会记得调工具，**服务端直接把全文写入 R2**，再把前 2 万字符塞进上下文（整段 6 万字符会一步吃掉大半预算） |
| ② AI 整理入库 | 微信任意文件（发送即触发）、Telegram 文本类文件、`/savekb`、「整理知识库 标题」 | 先落盘原文 → 模型提炼「核心摘要 / 结构化大纲 / 关键数据 / 检索标签」→ 用 `mode=prepend` 把大纲插到原文之前，**原文不会丢** |
| ③ 模型主动保存 | 对话里说「把…存成知识库文档」 | Agent 调 `save_doc`，可指定 `mode` / `tags` |
| ④ 手工精读与删除 | `/readdoc 关键词`、`/deldoc 关键词` | 两端都支持，不用等模型判断 |

**写入模式**（`save_doc` 的 `mode` 参数）

| 模式 | 语义 | 典型场景 |
| :--- | :--- | :--- |
| `auto`（默认） | 存在则覆盖，不存在则新建 | 普通保存 |
| `create` | 存在则**拒绝**并提示替代方案 | 防止误覆盖已有文档 |
| `overwrite` | 存在则覆盖 | 明确要更新 |
| `append` | 旧正文 + 新内容 | 「给这篇补一条」 |
| `prepend` | 新内容 + `---` + 旧正文 | 整理大纲插到原文前 |

**四道保护**

- **版本快照**：任何覆盖前把旧正文存到 `kb/versions/<slug>/<ts>.md`，只保留最近 3 份。误覆盖可以在 R2 控制台直接捞回。整理入库的两步写入用 `snapshot:false`，不占两个槽位。
- **内容指纹去重**：长度 + 前 4000 字的 djb2 哈希。同一篇资料换个标题重复入库会被挡住，提示「内容指纹一致」，并告诉你已存在哪一篇。
- **错误页拒收**：整篇不到 1200 字且开头是 `404 Not Found` / `403 Forbidden` / Cloudflare 人机校验页的，直接拒绝写入并说明原因——避免把抓取失败的残渣当资料存进库。长文档里引用一句 404 不受影响。
- **写操作串行化**：注册表是「读-改-写」，通过 Durable Object 在所有 isolate 间串行执行，避免并发保存互相覆盖；列表、旧正文或快照读取失败时中止写入并保留旧索引。

**标签检索**：`tags` 写进 frontmatter（`tags: Kubernetes, 容器, 运维`），注册表自愈重建时仍能解析回来；`kbFindRegEntry` 的匹配优先级变为 **标题精确 > 标题包含 > 标签命中 > slug 归一化 > 文件名**，所以「读一下容器相关的文档」也能命中。

**存储布局新增**：

```text
kb/docs/<标题>.md                文档正文（frontmatter 含 title/saved_at/chat_id/source/tags/fp/version）
kb/docs/registry.json            索引（file/title/source/tags/size/chars/fp/version/updated_at），可随时按文件重建
kb/versions/<标题>/<ts>.md       覆盖前的旧版快照（每篇保留 3 份）
```

**索引只是可重建的缓存**：`kb/docs/*.md` 是唯一真相，`registry.json` 随时可以从文件重建。保存时读最新索引并核对实际文件，`/kb` 也会核对一次——所以「文档在、列表里没有」这种情况会被自动修好，而不是永久留在库里。

## 🛡️ 微信 ClawBot 四重防盗绑安全机制

针对「公开网址是否会被路人随意扫码绑定或覆盖」的安全隐患，内置了 4 层纵深防护：

1. **强制管理员密钥校验（拒绝无密裸奔绑定）**：服务端必须配置 `WX_ADMIN_SECRET`（或 `ACCESS_PASSWORD`）并在网页端输入验证通过后，才允许请求二维码或解绑；若未配置任何密钥，网页端扫码绑定接口将**自动锁死拒绝**，路人知道网址也无法扫码。
2. **管理员与普通访客权限分离（`WX_ADMIN_SECRET`）**：如果你将网页端分享给朋友使用（共享 `ACCESS_PASSWORD` 或免密开放聊天），只需单独配置 `WX_ADMIN_SECRET`，即可让普通访客正常使用网页对话，但只有知道 `WX_ADMIN_SECRET` 的管理员能查看/绑定/解绑微信通道。
3. **一次绑定防覆盖锁（Bind-Once Lock）**：一旦你扫码绑定成功（或通过环境变量 `WX_BOT_TOKEN` 固定绑定），通道立即进入加锁状态，禁止直接生成新二维码覆盖，彻底杜绝被他人顶号。
4. **扫码人身份自动锁定（Owner Auto-Lock）**：扫码确认时，系统自动记录你的微信 `ilink_user_id` 为唯一合法主人（亦可手动配置 `WX_ALLOWED_USERS` 白名单），非本人微信号无法触发对话或污染知识库。

绑定确认与二维码生成都在跨实例 Bind-Once 锁内复核，已绑定后不存在强制换绑入口。`bot_token` 使用管理员密钥派生的 AES-256-GCM 密钥加密后存入 R2；旧明文记录仍可读取，并会在下次保存时迁移。二维码在浏览器本地生成，绑定内容不会发送给第三方二维码服务。

## 🚀 快速部署与通道绑定

##### 方式一

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jinhuaitao/cloudflare-chat)

##### 方式二

1. **导入 Git 部署**：Cloudflare 控制台 → **Workers & Pages** → **连接到 Git** 选择本仓库（构建命令留空，部署命令 `npx wrangler deploy`）。
   > 💡 `wrangler.toml` 已声明 **R2 自动置备**、**Durable Object 跨实例协调锁**、**Cron 定时触发器 (`* * * * *`)** 与 `keep_vars = true`，部署时会一并创建所需绑定。
   >
   > ⚠️ **免费计划必读**：免费账号的 Durable Object 只支持 SQLite 存储后端，迁移必须写 `new_sqlite_classes`。若写成 `new_classes`，部署会失败并报 `In order to use Durable Objects with a free plan, you must create a namespace using a new_sqlite_classes migration. [code: 10097]`。本仓库已按 SQLite 后端配置，直接部署即可。
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
4. **绑定 Telegram 机器人（可选）**：向 `@BotFather` 获取 Token，配置 `TG_BOT_TOKEN`、随机密钥 `TG_WEBHOOK_SECRET`、`TG_ALLOWED_CHAT_IDS` 与 `TG_ADMIN_IDS` 后重部署（公开机器人须显式设置 `TG_ALLOW_PUBLIC=true`），浏览器访问以下地址完成绑定：
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
| `WX_POLL_BUDGET_MS` | 🟢 可选 | `21000` | 单棒长轮询总预算（默认 18 秒拉取 + 3 秒收尾，上限 26 秒；自接力维持后台收发） |
| `WX_WEBHOOK_BUDGET_MS` | 🟢 可选 | `55000` | 微信单轮 Agent 运行预算（毫秒）；超时自动存档，微信发「继续」即可续做 |
| `WX_BASE_URL` | 🟢 可选 | `https://ilinkai.weixin.qq.com` | 微信 iLink 网关地址（扫码后会自动使用服务端下发的专属 `baseurl`） |
| `WX_CHANNEL_VERSION` | 🟢 可选 | `2.4.10` | 模拟 `@tencent-weixin/openclaw-weixin` 协议版本号（自动计算 `iLink-App-ClientVersion`） |

### 🤖 3. Telegram 机器人配置

| 变量名 | 级别 | 默认值 | 说明 |
| :--- | :---: | :---: | :--- |
| `TG_BOT_TOKEN` | 🔴 必填 | — | `@BotFather` 机器人 Token（启用 Telegram 机器人必填） |
| `TG_WEBHOOK_SECRET` | 🔴 启用必填 | — | Webhook 签名校验密钥（可用 `openssl rand -hex 24` 生成）；启用 Bot 但未配置时请求会被拒绝 |
| `TG_ALLOWED_CHAT_IDS` | 🔴 默认必填 | — | 允许使用的私聊 `user_id` 或群组 `chat_id` 白名单，逗号分隔；显式 `TG_ALLOW_PUBLIC=true` 才可公开 |
| `TG_ADMIN_IDS` | 🔴 管理必填 | — | 允许执行 `/wxstatus`、`/wxlogin`、`/wxunbind` 的 Telegram 用户 ID，逗号分隔 |
| `TG_ALLOW_PUBLIC` | 🟢 可选 | `false` | 设为 `true` 时允许白名单外的普通聊天；不影响管理命令的 `TG_ADMIN_IDS` 强制校验 |
| `TG_HISTORY_ROUNDS` | 🟢 可选 | `10` | 多轮对话保留轮数（上限 `30` 轮，Telegram 与微信共用，受 12,000 字符上下文安全预算保护） |
| `TG_BOT_USERNAME` | 🔵 自动 | `getMe` 探测 | 机器人用户名（不含 `@`），用于群聊识别 `@提及`，默认自动获取无需手填 |
| `TG_GROUP_REPLY_ALL` | 🟢 可选 | 仅提及响应 | 群聊模式：默认仅响应 `@机器人`、引用回复与 `/命令`；设为 `1` 则群内每条消息均回复 |
| `TG_API_TIMEOUT_MS` | 🟢 可选 | `15000` | Telegram Bot API 单次请求超时毫秒数（15 秒） |
| `TG_WEBHOOK_BUDGET_MS` | 🟢 可选 | `55000` | Webhook 单轮 Agent 运行预算（`10000`~`240000` 毫秒）；超时自动存档，发「继续」续做 |

### 🧠 4. Agent 引擎与工具配置

| 变量名 | 级别 | 默认值 | 说明 |
| :--- | :---: | :---: | :--- |
| `BRAVE_API_KEY` | 🟢 可选 | — | Brave 官方搜索 API Key（[免费申请](https://brave.com/search/api/)）。填了 `web_search` 优先走官方 API，结果最稳；不填则使用零密钥的 DuckDuckGo / Brave / Bing 多后端回退 |
| `AGENT_MAX_STEPS` | 🟢 可选 | `6` | 单轮任务最大工具推理步数（上限 `12` 步，耗尽后自动汇总收尾） |
| `AGENT_TIMEOUT_MS` | 🟢 可选 | `240000` | Agent 单轮任务全局超时上限（毫秒，默认 4 分钟） |
| `WEB_AGENT_TIMEOUT_MS` | 🟢 可选 | `90000` | Web 网页端 Agent 单轮超时预算（毫秒，默认 90 秒，范围 `10000`~`240000`） |
| `AGENT_TOOL_TIMEOUT_MS` | 🟢 可选 | `30000` | 单个工具单次执行超时上限（毫秒，默认 30 秒；实际生效值还会被本轮剩余预算压缩） |
| `AGENT_TOOL_CONCURRENCY` | 🟢 可选 | `4` | 单步内并行执行工具的最大并发数（范围 `1`~`8`），防止模型一次吐 8 个调用时同时打出 8 个外部请求 |
| `AGENT_CONTEXT_BUDGET` | 🟢 可选 | `24000` | 单轮上下文字符预算，超出时先折叠早期工具输出，仍超则压缩更早的历史轮次（保留最近 2 轮原文） |
| `AGENT_WRAP_RESERVE_MS` | 🟢 可选 | `8000` | 收尾预留时间：剩余预算低于该值时不再发起新工具调用，直接汇总作答（自动按单轮预算 30% 封顶） |
| `AGENT_STREAM_UPSTREAM` | 🟢 可选 | 开启流式 | 设为 `0` 可关闭 Agent 上游流式输出，退回整段生成后一次性返回 |
| `AGENT_KEEP_REASONING` | 🟢 可选 | 关闭 | 设为 `1` 时把模型思维链（`reasoning_content`）回灌到后续步骤。默认关闭：推理模型一步几千字，回灌会快速挤爆上下文并触发压缩；只有少数要求回传思维链的上游才需要打开 |
| `AGENT_DEBUG_STATS` | 🟢 可选 | 关闭 | 设为 `1` 时每轮输出一行 `[agent-stats]` 统计（步数/工具数/上下文规模/固定开销/耗时），配合 `wrangler tail` 量化调优 |

### 🗂️ 4b. 三层记忆配置

> 三层记忆默认全开、无需任何配置。以下变量只在需要调整容量/行为时才用。

| 变量名 | 级别 | 默认值 | 说明 |
| :--- | :---: | :---: | :--- |
| `WEB_WORKING_MEMORY` | 🟢 可选 | 关闭 | 设为 `1` 时 Web 端也写 L1 工作记忆（按 `web_<session>` 隔离，不影响机器人端）。默认关闭：公开网页每轮往 R2 写一次没有收益 |
| `MEM_L1_MAX_ITEMS` | 🟢 可选 | `12` | L1 会话要点上限，超出后最旧的一条沉淀进 L3（范围 `4`~`30`） |
| `MEM_L2_MAX_ITEMS` | 🟢 可选 | `240` | L2 长期记忆上限，超出后按衰减分淘汰最弱的（范围 `50`~`1000`） |
| `MEM_L2_HALFLIFE_DAYS` | 🟢 可选 | `45` | L2 时间衰减半衰期（天）。调小＝更看重近期说法，调大＝老事实更抗跌 |
| `MEM_L3_MAX_ITEMS` | 🟢 可选 | `400` | L3 归档上限，超出丢最旧 |
| `MEM_PROMPT_BUDGET` | 🟢 可选 | `5500` | 三层记忆注入提示词的总字符预算（L1/L2/L3 按 16:30:9 分配） |

### 🛡️ 5. 安全、限流与站点验证

| 变量名 | 级别 | 默认值 | 说明 |
| :--- | :---: | :---: | :--- |
| `ACCESS_PASSWORD` | 🟠 推荐 | 免密访问 | Web 端 `/api/chat` 访问口令（前端通过 `X-Access-Token` 校验） |
| `RATE_LIMIT_PER_MIN` | 🟢 可选 | `60` | 单 IP 每分钟 `/api/chat` 请求上限；设为 `0` 关闭限流 |
| `CORS_ORIGIN` | 🟢 可选 | `*` | 跨域白名单，逗号分隔完整域名（如 `https://chat.example.com`） |
| `VERIFY_FILE_PATH` / `VERIFY_FILE_CONTENT` | 🟢 可选 | — | 域名所有权验证路径（如 `/MP_verify_xxx.txt`）与返回的纯文本内容 |

## 📱 Telegram & 微信 ClawBot 交互与 19 项零密钥工具

### 机器人常用指令（Telegram & 微信 ClawBot 通用）

| 指令 / 操作 | 功能说明 |
| :--- | :--- |
| `/start` · `/model` | 查看或切换当前会话 AI 模型（Telegram 弹出内联按钮；微信展示编号列表，发 `/model 序号` 或 `/model 模型名` 即可切换） |
| `/agent` | 切换 **🤖 Agent 模式**（默认开启）与 **💬 普通对话模式** |
| `/clear` · `/new` | 清空当前会话多轮上下文与断点存档，并清掉 **L1 工作记忆**（L2 长期事实与 L3 归档保留） |
| `/memory` | 查看**三层记忆**视图：L1 会话要点 / L2 长期事实（按强度排序）/ L3 归档 |
| `/forget <词>` | 删除包含关键词的长期记忆，并解除同关键词的 L1 固定项（或直接说「忘掉…」） |
| `/kb` · `/help` | 查看知识库总览（三层记忆统计 + 文档列表 + 快捷操作提示） / 查看帮助、版本号与当前会话 ID |
| `/savekb <标题>` | **把最近这段对话自动整理成结构化文档入库**（不填标题则用日期命名）；微信端也可发「整理知识库 标题」 |
| `/readdoc <词>` · `/deldoc <词>` | 按标题/标签关键词精读某篇文档全文 / 删除某篇文档；微信端对应「读取文档 标题」「删除文档 标题」 |
| `/wxlogin` · `/wxstatus` · `/wxunbind` | **（仅 Telegram 私聊管理员）** 直接在 Telegram 中获取微信 ClawBot 扫码绑定链接、查看状态或解绑 |
| **语音 / 传图 / 续做** | 微信支持直接发语音对话；两端均支持直接发图识图、传 `.md/.txt/.csv/.json`/代码文件分析（附言「存进知识库」即全文入库）；长任务暂停后发 **「继续」** 续做 |

### 内置 19 项零密钥 Agent 工具箱

| 分类 | 内置工具 | 能力摘要（全部免额外 API Key） | 可用范围 |
| :--- | :--- | :--- | :---: |
| 🔍 **联网与抓取** | `web_search` · `web_fetch` | 多后端搜索（DuckDuckGo → Brave → Bing 自动回退，反爬时明确报错而非「无结果」，并预读前 2 条正文）；结构化抓取网页（3 URL 并发、`offset` 0ms 翻页、Jina 阅读器与 Wayback 快照回退） | 🌐 Web + 🤖 TG + 🟢 微信 |
| 🌐 **百科与社区** | `wiki_lookup` · `github_lookup` · `arxiv_search` · `hn_top` | 中英维基百科词条；GitHub 仓库 Star/Release/README 检索；arXiv 论文检索；Hacker News 实时热榜与高赞讨论 | 🌐 Web + 🤖 TG + 🟢 微信 |
| 🧮 **计算与工具** | `calculate` · `toolkit` · `get_time` · `get_weather` · `exchange_rate` · `net_lookup` | 科学计算器（支持 `;` 批量计算）；单位换算/SHA哈希/Base64·URL编解码/UUID/Token 统计/**JSON 格式化与路径取值**/**正则测试**；时区与日期差推算；多城市天气预报；160+ 法币与加密货币汇率；DoH DNS 与 IP 归属诊断 | 🌐 Web + 🤖 TG + 🟢 微信 |
| 📖 **知识库检索** | `list_docs` · `read_doc` | 列出知识库文档清单；按标题或多关键词加权检索文档正文（L1 内存缓存支持 `offset` 0ms 翻页） | 🌐 Web + 🤖 TG + 🟢 微信 |
| 🧠 **三层记忆** | `memory` | `search` 一次问 L1/L2/L3 并标明来源层；`stats` 看各层条数；`pin` 固定本会话约束（如「这次都用英文回答」） | 🌐 Web（只读）+ 🤖 TG + 🟢 微信 |
| 💾 **记忆与写入** | `remember` · `forget_memory` · `save_doc` · `delete_doc` | 长期记忆存取，支持 `kind`（事实/偏好/身份/任务）与 `weight`（1-5）；同主题自动覆盖并同步 `.md` 镜像；`save_doc` 支持 `mode`（`create`/`overwrite`/`append`/`prepend`）与 `tags`，覆盖前自动存版本快照、按内容指纹挡重复、拒收 404 错误页；`delete_doc` 按标题删除 | 🤖 TG + 🟢 微信 |

## 🧪 本地回归测试

```bash
npm test                  # 全部离线回归：内核、Worker 路由、分布式租约、故障注入、知识库/记忆、机器人、SSRF 与前端约束
npm run build:tts-demo    # 从 src/ui/speech.js 重新生成 tts-demo.html（改了朗读规则才需要跑）
```

覆盖：并发闸门、两/三阶段上下文裁剪与配对安全、工具参数修复、失败判定、DSML 兼容、
提示词注入、工具箱新动作、并行工具调用 → 执行 → 汇总作答全链路、两种空转熔断、
预算耗尽不请求上游、首步 4xx 降级、截断提示、断点起点修正、SSE 分片与错误事件、
知识库注册表自愈重建、全库正文检索、`offset` 越界预检、列表限流、
`mode` 四种写入模式、版本快照保留 3 份、内容指纹去重、错误页拒收、标签解析与标签检索、
并发保存不丢条目、整理标签抽取、上传标题反推、原文+大纲两步写入与重复整理判重、
索引与文件脱节时的自动修复、跨实例保存不覆盖他人条目、重建后保留 fp/version；
三层记忆的要点抽取与同话题合并、L1 溢出沉淀、TTL 过期、固定项上限、L2 主题覆盖与命中计数、
旧格式迁移、容量淘汰与归档、L3 去重、统一检索、提示词三层渲染与预算、环境变量夹取；
SSRF 全规则（私网/保留段/云元数据/IPv6 映射与 NAT64/十进制与十六进制归一化/FQDN 尾点）、
微信 MD5 与 AES-128-ECB 对拍 `node:crypto`、Markdown→微信排版、长文本分段、中英双语口令、
通道配置三级回退与同名模型跨通道、朗读清洗行为、演示页与源码一致、前端分片转义约束。

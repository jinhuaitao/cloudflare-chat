# Cloudflare-Chat

基于 Cloudflare Workers 的多通道 AI 对话前端 + Telegram 机器人。单文件 Worker（`_worker.js`），通过 `wrangler.toml` 声明式配置，支持连接 GitHub 仓库自动构建部署。当前版本 v6.8.8。

## 功能一览

- **多通道 AI 对话前端**：网页聊天 UI，支持多模型 / 多通道（OpenAI、通义千问、DeepSeek 等兼容 OpenAI 接口的通道），PWA 可安装，支持离线打开外壳
- **Telegram 机器人**：多轮对话（默认记 10 轮）、`/model` 内联按钮切换模型
- **Agent 模式**（默认开启，Web 与 Telegram 共用）：ReAct 循环自主规划，10 个零密钥工具 —— 🔍 联网搜索、📄 网页抓取、🧮 精确计算、🌤 天气、🕐 时间、🧠 长期记忆、💾 知识库文档保存、📚📖🗑️ 文档检索与删除
- **知识库**：长期记忆（`remember`）+ 知识库文档（`save_doc`），全部持久化在 R2 的 `kb/` 独立文件夹
- **语音朗读**：浏览器原生语音合成，零成本、零密钥

## 前置条件

- 一个 Cloudflare 账号
- 一个 GitHub 账号（用于存放本仓库）
- 至少一个兼容 OpenAI 接口格式的 API 通道（OpenAI、通义千问、DeepSeek 等均可）

---

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

### 多轮对话

机器人默认记住最近 **10 轮**对话（可通过环境变量 `TG_HISTORY_ROUNDS` 调整，最大 30；另有 12000 字符的总预算，超限自动丢弃最旧的消息）。历史存 R2，机器人重启不丢失。发送 `/clear` 可清空当前上下文、开启新话题。

> 注意：图片生成类模型不记入历史（只记文本问答），每次按单轮处理。

### Agent 模式（默认开启）

机器人不再是简单的问答机，而是一个 **Agent**：以 LLM 为核心推理引擎，能自主规划、多步调用工具、长期记住你。

**可用工具**（全部零密钥、零成本）：

| 工具 | 能力 | 示例触发 |
|---|---|---|
| `web_search` | 联网搜索最新信息（DuckDuckGo） | "今天有什么 AI 大新闻？" |
| `web_fetch` | 抓取网页正文并总结 | "总结一下这篇文章：<链接>" |
| `calculate` | 精确数学计算（自研解析器，拒绝注入） | "帮我算 (3280-1299)*1.13" |
| `get_time` | 当前时间（可指定时区） | "现在几点了" |
| `get_weather` | 城市天气 + 今明两天预报（Open-Meteo） | "北京明天适合跑步吗" |
| `remember` | 长期记住关于你的事实（R2 持久化，不限条数） | "记住，我养了一只猫叫汤圆" |
| `save_doc` | 把长篇内容保存为知识库文档（真实写入 R2 `kb/docs/`，同链接自动去重） | "把这篇文章存成知识库文档" |
| `list_docs` | 列出知识库文档标题 | （自动调用） |
| `read_doc` | 按标题关键词读取知识库文档全文 | （自动调用） |
| `delete_doc` | 删除一篇知识库文档 | "删除知识库文档《甲骨文ARM》" |

**工作方式**：ReAct 循环 —— 模型先判断意图，简单问题直接回答；需要时自主规划多步（比如先搜索再抓取原文、先计算再汇总），最多 6 步，工具结果回填后综合作答，绝不编造。

**记忆**：短期记忆是多轮对话历史；长期记忆是你明确告知的事实（`remember`，每条不超过 200 字，不限条数），每次对话按相关性自动注入，无需重复介绍自己。

**知识库文档**：`save_doc` 专门用来存长篇内容（如"抓取这篇文章并生成知识库文档"），同名保存即覆盖更新并会明确提示。只有工具真正返回成功，机器人才会告诉你"已保存"；`remember` 存不下整篇文章，不要混用。**同一网址只保存一次**：换标题重复保存会被拒绝（指引你用原标题覆盖或先删除），标题仅差空格也会归一为同一文件名。所有文档在 `kb/docs/registry.json` 注册表里统一登记，去重/列表/删除都走注册表。提问时若问题可能涉及知识库文档主题，机器人会先 `list_docs` 看标题、再 `read_doc` 细读（标题想不起来时会自动搜正文），**文档内容优先引用**并注明出处；`delete_doc` 可删除文档，`/kb` 可查看知识库总览。

**命令**：
- `/agent` —— 在 Agent / 普通对话模式间切换（选择保存在 R2，默认 Agent 开启）
- `/model` —— 切换模型；`/clear` —— 清空上下文
- `/memory` —— 查看长期记忆；`/forget 关键词` —— 删除记忆；`/kb` —— 知识库总览（文档列表 + 记忆统计）；`/help` —— 命令列表

**兼容性**：依赖通道/模型的原生 function calling。若你的通道不支持 `tools` 参数，机器人会自动降级为普通对话模式，不会报错（可在实时日志中看到降级）。图片生成类模型不受影响。

---

# 第五步：语音朗读回复（已内置，无需配置）

前端已内置「把 AI 回复读出来」的能力，基于浏览器原生 **Web Speech API**：

- **单条朗读**：每条 AI 回复下方有一个「朗读」按钮，点击即朗读该条内容，再点一次（按钮变为「停止」）即中止。
- **自动朗读**：左下角侧边栏的**喇叭图标**是一个开关，开启后每次 AI 回复生成完毕会自动朗读，开关状态保存在浏览器本地。
- **智能清洗**：朗读前会自动把 Markdown 转成适合听的纯文本 —— 代码块替换为「（代码块已省略）」、行内代码保留文字、链接只念标题、表格与分隔线去掉，不会念出一堆符号。
- **语言自动识别**：含中日韩字符时使用 `zh-CN`，否则使用 `en-US`。
- **零成本、零密钥**：使用操作系统自带的语音合成，不调用任何云端 TTS 接口，不产生费用，也不需要额外环境变量。

> 声音由浏览器与操作系统决定。如果觉得音色不理想，可在系统设置里添加/更换语音包（macOS：系统设置 → 辅助功能 → 朗读内容 → 系统声音）。
>
> 兼容性：Chrome / Edge / Safari 桌面版均支持；部分移动端浏览器对语音合成的支持有限，此时点击「朗读」会给出提示。

---

# 第六步：PWA（已内置，无需配置）

前端已具备完整的 PWA 能力，可以像原生 App 一样安装到桌面 / 主屏幕，并支持离线打开。

| 能力 | 实现 |
| --- | --- |
| Web App Manifest | `GET /manifest.webmanifest`，`display: standalone`，含 192/512 + maskable 图标 |
| Service Worker | `GET /sw.js`，挂在根路径，`Service-Worker-Allowed: /`、`Cache-Control: no-cache` |
| 图标 | `GET /icon-192.png`、`/icon-512.png`、`/icon-maskable-512.png` |
| 健康探针 | `GET /healthz`，供前端与 SW 判断服务端是否可达 |
| 安装入口 | 侧边栏左下角的下载图标，浏览器判定可安装后自动出现 |
| 离线提示 | 顶部橙色横幅，断网时滑入，恢复后自动消失 |

**图标以 base64 内嵌在 `_worker.js` 里，运行时解码**，不引入任何静态资源文件 —— 这样「单文件 Worker、无额外构建产物、直接连 Git 部署」的方式完全不受影响。

### 缓存策略

| 请求类型 | 策略 |
| --- | --- |
| 页面导航（`/`） | network-first，断网回退到缓存的应用外壳 |
| 同源静态资源（图标 / manifest） | cache-first |
| 第三方 CDN（marked、highlight.js、Google Fonts） | stale-while-revalidate |
| `/api/*`、`/tg-webhook` | **完全放行，绝不缓存** |
| `/healthz` | **完全放行，绝不缓存**（关键，见下） |

> `/healthz` 必须显式绕过缓存。若 SW 缓存了它，探针会被缓存应答 → 永远「探测成功」→ 离线横幅的自动重连逻辑形同虚设。

### 缓存版本号自动跟随代码变化

缓存名形如 `cloudflare-chat-<hash>`，其中 `<hash>` 是**页面 + SW 源码的内容哈希**，在 Worker 里实时计算（`getPwaVersion()`）。

好处：只要改了前端页面或 SW，版本号自动变化 → 浏览器触发 SW 更新 → `activate` 里清掉旧缓存。因为它是纯函数（只依赖源码文本），isolate 重启后依然稳定，不会导致 SW 反复更新。**你不需要手动维护版本号。**

### 怎么验证安装成功

- **Chrome / Edge（桌面）**：地址栏右侧出现安装图标，或侧边栏左下角的下载按钮。
- **Android Chrome**：菜单 →「安装应用」/「添加到主屏幕」。
- **iOS Safari**：分享 →「添加到主屏幕」（走 `apple-touch-icon` 与 `apple-mobile-web-app-*` meta，无需 manifest 也能装）。

安装后以独立窗口运行，不再显示浏览器地址栏。

### 离线能力的边界

离线时**只能打开应用外壳**（界面、历史会话、已缓存的主题与图标都在），但**对话本身仍然需要网络** —— `/api/chat` 是实时接口，不缓存。断网时发送消息会失败，此时顶部横幅会提示，并在网络恢复后自动消失。

---

# 常见问题

**Agent 说"已保存"但 R2 里看不到知识库文档**

按顺序排查：
1. 先确认部署的版本：给机器人发 `/help`，看版本号是不是 v6.8.8+。v6.8.2 及更早版本在 R2 未绑定时会谎称"已保存"（v6.8.3 起会明确报错）；v6.8.3 及更早版本在**并发保存或注册表写入失败时仍可能"已保存但查不到"**（v6.8.4 起注册表更新带写入后校验 + 重试，确认失败会如实报错）。
2. 给机器人发 `/kb`：如果回复"R2 未绑定"，说明 Worker 没有 R2 绑定——去 Cloudflare 控制台 Workers & Pages → 你的 Worker → 设置 → 绑定，确认 R2 存储桶已绑定（变量名必须是 `R2`），然后重新部署。
3. R2 控制台确认 bucket 里有 `kb/docs/` 前缀的对象。注意文件名是标题去掉空格和特殊字符后的结果（如标题"甲骨文云 ARM"存为 `甲骨文云ARM.md`），用 `/kb` 看到的标题列表为准。**如果 R2 里有文件但 `/kb` / `list_docs` 看不到**：说明注册表丢了该条目（旧版本并发 bug），直接删除 `kb/docs/registry.json`，下一次列表操作会自动扫描重建。
4. 如果曾在 v6.8.1 遇到过 `loopStartIdx is not defined` 报错：那次 Agent 是中途崩溃的，工具可能没执行完，重试一次即可（v6.8.2 已修复）。

**Agent 进度条卡在"💾 正在保存文档"（或其它工具进度）不动**

v6.8.5 之前的进度显示 bug，不是真的卡死：工具本身执行很快（save_doc 实测 8 万字只要十几毫秒），但"第 N+1 步"的"思考中"标签会被上一步工具进度的节流吞掉，界面就 frozen 在上一步。Agent 实际已在下一步等待上游 LLM——推理模型处理长文时单步可达数分钟，期间只显示 typing 状态。v6.8.5 起步骤标签走独立节流通道，不会再被吞。单个工具另有 30 秒超时保护，不会无限执行；如果 5 分钟以上毫无动静，去 Cloudflare 实时日志看上游接口是否报错。

**部署日志报 `Missing id` 或要求交互式输入**

构建环境使用的 Wrangler 版本过旧，不支持自动置备。确认仓库根目录存在 `package.json` 且其中声明了 `wrangler ^4.0.0`。若仍失败，按第二步「如果自动置备失败」手动创建 R2 bucket 并把 `bucket_name` 写进 `wrangler.toml`。

**部署日志报 `Binding at index N must have a name [code: 10052]`**

`wrangler.toml` 里某个绑定的 `binding` 是空字符串。binding 名不能为空，R2 的必须是 `R2`。注意这个错误还可能在账号里留下一个名字畸形的孤儿 bucket，需要手动去 R2 页面删掉。

**页面一直提示 API 错误 / 模型下拉框是空的**

如果下拉框显示「未配置模型，请检查环境变量」，说明 Worker 没有读到任何模型配置：检查 `API_URL_1` / `API_KEY_1` / `MODEL_1` 三件套是否齐全、编号是否从 1 开始连续，以及改完变量后是否重新部署过。

注意 `MODEL_1` 只有和 `API_URL_1` 同时存在时才会生效 —— 只填模型名不填接口地址不会产生任何模型。

如果下拉框有模型但对话报错，多半是 `API_KEY_1` 没填或填错，可以在 Cloudflare 的实时日志（Workers & Pages → 你的 Worker → Logs）里看到上游接口返回的具体报错。

**提示「需要访问口令」**

服务端已配置 `ACCESS_PASSWORD`，但浏览器里没有口令或口令不一致。点击左下角设置图标，在「访问口令」中填入与服务端一致的值后重新发送即可。

若你并不想启用口令，把服务端的 `ACCESS_PASSWORD` 变量删除后重新部署，即可恢复开放访问。反过来，如果你没配置过 `ACCESS_PASSWORD` 却收到 401，说明有人给这个 Worker 加了口令，去「设置 → 变量和机密」确认一下。

**每次部署都会重复创建 R2 bucket**

去 R2 页面确认是否出现多个同名或相似名字的 bucket。若有，删除多余的，并在 `wrangler.toml` 中用 `bucket_name` 把正确的 bucket 名固定下来，不再依赖置备逻辑。

**改了环境变量但前端模型列表没更新**

`wrangler.toml` 的 `keep_vars = true` 只保证变量不被清空，不会让改动立即生效。需要在 **设置 → 变量和机密** 修改后重新触发一次部署。

**改前端代码后正则失效 / 报 `Invalid regular expression: Unmatched ')'`**

这是本项目最容易踩的坑，属于**两层转义**问题：`HTML_CONTENT` 是一段模板字符串，里面的内联 JS 会被转义两次 ——

1. 模板字符串先解析一层：`'\\['` → `'\['`
2. 浏览器再解析 JS 字符串字面量一层：`'\['` → `'['`（反斜杠被吞掉）

结果正则里的 `\[` 变成 `[`，表达式直接崩。同理，模板字符串里出现反引号（`` ` ``）会直接截断整个 `HTML_CONTENT`。

**规避方式**（朗读功能就是这么写的）：前端代码里**不写任何反斜杠和反引号**，用字符码拼接：

```js
const BT = String.fromCharCode(96);  // 反引号
const BS = String.fromCharCode(92);  // 反斜杠
const rx = p => p.split('@').join(BS);   // 用 @ 占位，运行时展开成反斜杠
```

**验证方式**：不要直接对 `_worker.js` 源码做语法检查 —— 那样读的是模板源码，看不出转义问题。必须**先让 Worker 跑一次 `GET /` 拿到求值后的 HTML**，再对其中 `<script>` 的内容做检查与实测。

**PWA：侧边栏没有出现安装按钮**

安装按钮由浏览器的 `beforeinstallprompt` 事件驱动，只有满足全部条件才会触发：

1. 通过 **HTTPS** 访问（`*.workers.dev` 自带 HTTPS；`localhost` / `127.0.0.1` 也算安全上下文）；
2. `/manifest.webmanifest` 返回 200 且含 `name`、`start_url`、`display: standalone`、至少一个 192px 以上的图标；
3. `/sw.js` 能成功注册且 scope 为 `/`；
4. 该站点尚未被安装过。

任一条不满足按钮就不会出现 —— 此时仍可用浏览器菜单里的「安装应用」或 iOS 的「添加到主屏幕」。

**PWA：离线时界面能打开，但发消息没反应**

这是预期行为。离线只保证**应用外壳**可加载（界面、历史会话、主题、图标），对话走的 `/api/chat` 是实时接口，不缓存也不该缓存。顶部横幅会提示断网，网络恢复后自动消失，重发即可。

**PWA：改了前端，用户看到的还是旧页面**

正常情况下不需要处理 —— 缓存版本号由页面 + SW 的内容哈希自动生成，代码一变缓存名就变，SW 更新后旧缓存会在 `activate` 阶段清除。

如果仍然看到旧内容，通常是浏览器还持有旧的 Service Worker 在等待激活。手动处理：DevTools → Application → Service Workers → 勾选 **Update on reload**，或点 **Unregister** 后刷新。也可以在 Application → Storage 里 **Clear site data** 彻底重置。

---

# 安全提示

- **`/api/chat` 支持访问口令**：配置环境变量 `ACCESS_PASSWORD` 即生效，未配置则保持开放。部署在公开域名上时建议务必配置，见第三步的「访问口令」小节。
- **`/api/chat` 按 IP 限流**：默认每 IP 每分钟 60 次（`RATE_LIMIT_PER_MIN` 可调，设 0 关闭），多一层防刷。
- **`/tg-webhook` 来源校验**：配置 `TG_WEBHOOK_SECRET` 后，只接受 `setWebhook` 时传入相同 `secret_token` 的请求。**未配置时任何人都能 POST 伪造 update、烧你的 API 配额并污染知识库**（兼容旧部署才保持开放）；公开使用时必须配置。未配置时服务端会在日志里打一次 ⚠️ 告警（`wrangler tail` 可见）。
- **Telegram 聊天白名单（v6.8.1 新增）**：配置 `TG_ALLOWED_CHAT_IDS`（逗号分隔的 chat id，只填你自己的）后，机器人只响应名单内的聊天，其他一律静默忽略。个人自用强烈建议配置——否则任何陌生人私聊机器人都能烧你的 key。
- **Agent `web_fetch` 的 SSRF 防护（v6.8.1 新增）**：拦截内网 / 本机回环 / 链路本地（169.254.x）/ 云元数据地址及 `localhost` 等危险主机名，防止 Worker 被当成代理。但 Workers 拿不到底层 DNS，DNS 重绑定类攻击仍需在前置 WAF 层封堵。
- **AI 回复经 XSS 清洗**：前端所有 AI 生成内容先经 Markdown 渲染，再过 DOMPurify 白名单清洗后才插入页面；CDN 加载失败时降级为纯文本显示。
- **CORS 为 `*`**：`Access-Control-Allow-Origin: *` 允许任意站点调用你的接口。如果只在自己的域名下使用，建议收紧为实际域名。
- **API Key 只存在于服务端**：密钥通过环境变量注入，不会下发到浏览器，前端只能看到模型名称。

> 关于口令强度的说明：口令以明文形式保存在浏览器 localStorage 中，并通过请求头传输（HTTPS 加密）。服务端比较采用定长实现，可避免通过响应耗时逐字节猜解。它能有效挡住扫描器和随手调用接口的人，但不宜作为对抗定向攻击的唯一防线。

---

# 附：环境变量一览

| 变量 | 说明 | 默认值 |
|---|---|---|
| `TG_WEBHOOK_SECRET` | Telegram webhook 校验密钥，见第四步 | 未配置=不校验 |
| `TG_ALLOWED_CHAT_IDS` | Telegram 聊天白名单（逗号分隔），只响应名单内的聊天 | 未配置=开放 |
| `TG_HISTORY_ROUNDS` | 机器人记住的最近对话轮数（最大 30） | `10` |
| `MAX_TOKENS` | `/api/chat` 与机器人共用的 `max_tokens`（上限 32000） | `4096` |
| `RATE_LIMIT_PER_MIN` | 每 IP 每分钟 `/api/chat` 限额，`0` 关闭 | `60` |
| `AGENT_MAX_STEPS` | Agent 单轮任务最大推理步数（上限 12） | `6` |
| `AGENT_TIMEOUT_MS` | Agent 单轮任务总超时（毫秒） | `240000`（4 分钟） |
| `AGENT_TOOL_TIMEOUT_MS` | 单个工具最长执行时间（毫秒） | `30000`（30 秒） |
| `AGENT_CONTEXT_BUDGET` | Agent 单轮任务上下文字符预算，超预算裁剪本轮旧 tool 轮次（v6.8.1 起断点续做「继续」时也会裁剪，不再无限增长） | `24000` |
| `WEB_AGENT_TIMEOUT_MS` | 网页端 Agent 单轮任务总超时（毫秒），10 秒 ~ 240 秒。Web 是浏览器长连接，不需要 Telegram 的 55 秒妥协，单独给一个更短的预算 | `90000`（90 秒） |
| `AGENT_STREAM_UPSTREAM` | 设为 `0` 可关闭 Agent 真流式，退回「等整段生成完再显示」。仅在通道不支持「流式 + tools」组合时需要。关闭时不会向上游请求 `stream: true` | 未配置=开启流式 |
| `TG_STREAM_EDIT_MS` | Telegram 流式输出的刷新间隔（毫秒），1000 ~ 10000。设为 `0` 完全关闭 Telegram 流式编辑，回到「思考中 → 直接出整段答案」的旧行为 | `2000`（2 秒） |
| `TG_API_TIMEOUT_MS` | Telegram Bot API 单次调用超时（毫秒） | `15000`（15 秒） |
| `TG_WEBHOOK_BUDGET_MS` | webhook 内 Agent 单轮预算（毫秒），10 秒 ~ 240 秒。**这是"整轮"预算**（含降级重试），不是单次上游调用 | `45000`（45 秒） |
| `TG_WEBHOOK_RESERVE_MS` | 从上面的预算里扣出来的收尾预留（毫秒）：暂停存档 / 最终回复 / 历史落库。最多占预算的 1/4 | `6000`（6 秒） |

---

# 附：杂项说明

- **`tts-demo.html`**：朗读功能的独立演示页，**Worker 不提供对应路由**，直接在浏览器本地打开即可查看，不参与部署。
- **`test-agent.js` / `test-dsml.js`**：本地回归测试脚本（Node 直接运行），不参与部署；上传到 GitHub 可选，不影响构建。
- **`/a9a015a0f6e7c9ca09f4cdce4479deb3.txt`**：域名所有权验证文件（第三方平台验证用），内容固定；确认不再需要时可删除 `_worker.js` 中对应路由。

---

# 附：本地补丁记录（非上游版本）

本仓库的 `_worker.js` 在上游 v6.8.3 基础上打过四轮补丁（p1-1 / p1-2 / p1-3 / p1-4），`APP_VERSION` 标记为 **`6.8.3-p3`**
（给机器人发 `/help` 看到带 `-p3` 即说明部署的是打过补丁的构建）。以下改动**不在**上游 v6.8.4 ~ v6.8.8 里，
升级上游代码时请留意会被覆盖。

## p1-1 修复「网页版 Agent 一直卡在思考中」

| 问题 | 原因 | 修复 |
|---|---|---|
| 气泡永久停在打字动画 | 前端 `if (agentMode) break;` 排在「补全 `streamError`」之前，连接被干净关闭且没收到 `[DONE]` 时会执行 `throw null`，紧接着 catch 里读 `error.name` 又抛 TypeError，错误文案永远写不进气泡 | 补错语句前移；catch 首行兜底 `if (!error) error = ...`；finally 再加一道保险，残留 `.typing-indicator` 一律替换成明确提示 |
| 长静默连接被掐断 | Web 端零心跳（`noOpTgApi` 把 typing 心跳变成了空操作） | 每 15 秒发一个 `: keep-alive` SSE 注释行，前端按 `data:` 过滤，不受影响 |
| 服务端假死时无限等待 | 前端读取循环没有任何超时 | 加 90 秒空闲看门狗，超时主动断开并提示，用 `idleTimedOut` 与「用户手动中止」区分 |
| 服务端错误被吞 | `data.error` 的 `throw` 被外层空 `catch (e) {}` 吃掉 | 拆出解析与抛出，抛 `ServerError`；重试循环对它不重试 |
| 通道不支持 tools 时不降级 | 降级判定只认错误文本含 `tool` | 首步 4xx 一律降级重试；5xx 仅在错误文本含 `tool/function/unsupported` 时降级 |
| 干等 4 分钟 | Web 沿用 `AGENT_TIMEOUT_MS` 的 240 秒默认值 | 新增 `WEB_AGENT_TIMEOUT_MS`，默认 90 秒 |

## p1-2 Agent 真流式（逐字输出）

原实现里 Agent 循环用 `stream: false` 调上游，且正文要等整个 ReAct 循环跑完才一次性切片下发 ——
所以只要开着 Agent（默认开启），再简单的问题也要盯着「思考中」干等整段生成。

补丁把上游调用改为 `stream: true`，边读 SSE 边转发：

- 新增 `readUpstreamMessage()`，把上游 SSE 还原成与非流式**完全相同**的 `{ content, reasoning, toolCalls, forwarded, imageUrl }` 形状 ——
  循环里的 `tool_calls` 判定、DSML 兜底、重复调用熔断、工具执行逻辑**一行未改**，变的只是「怎么拿到 msg」。
- 正文 / `reasoning_content` 增量以标准 OpenAI `delta` 事件实时转发，前端本来就在按这个格式解析，**逐字渲染零改动**生效。
- 流式 `tool_calls` 分片按 `index` 合并（`arguments` 累加，`name` 取首个分片）。
- 新增 `agent_reset` 事件：模型先输出「开场白」再调工具时，服务端会撤回已经推出去的这段文本，
  避免它和最终答案首尾拼在一起；DSML 标记被推出去时同样撤回。
- 兼容三种上游形态：标准 SSE、忽略 `stream` 参数直接返回完整 JSON、图片生成通道。
- 可用 `AGENT_STREAM_UPSTREAM=0` 关闭，退回整段等待。

> 已知取舍：若模型在调用工具前先输出了一段较长的「开场白」，用户会看到它出现后又被撤回（通常只有几百毫秒）。
> 模型一旦发出 `tool_calls`，该步的后续正文就不再外发，尽量缩小这个窗口。

## p1-3 Telegram 端也接上真流式

p1-2 只接了网页端：`onDelta` 回调仅在 `/api/chat` 传入，Telegram 路径没有传 —— 于是它的上游请求虽然因为全局开关
变成了 `stream: true`，增量却被读进来后直接丢弃，**没有任何收益，只多了一个「通道不支持 stream + tools」的风险面**。

补丁把 Telegram 也接上：

- `agentOpts` 传入 `onDelta` / `onReset`。增量回调**只更新内存缓冲**，不做网络 I/O ——
  上游读取循环里 `emit()` 是 `await onDelta` 的，回调里一旦发请求就会把整个流拖慢。
- Telegram 对同一条消息的 `editMessageText` 限流很严（超了返回 429），所以不做逐字编辑：
  用定时器按 `TG_STREAM_EDIT_MS`（默认 2 秒）把「当前完整文本」刷一次，用户看到文字一段段长出来。
- 进度文案与流式正文**共用同一条占位消息**：每步开始 / 工具调用时正文缓冲作废、改回显示进度，
  所以「先开场白再调工具」时开场白会被工具进度直接顶掉，不会像网页端那样出现「显示后再撤回」的闪烁。
- 收尾不再「删掉占位消息 + 发新消息」，而是**把占位消息原地编辑成正式回复**（Markdown 解析失败退回纯文本），
  否则用户会看到答案闪一下又跳出来。`message is not modified` 视为成功；编辑彻底失败才退回删+发。
- `useUpstreamStream` 收紧为 `AGENT_STREAM_UPSTREAM !== '0' && typeof onDelta === 'function'` ——
  没人消费增量时就不请求流式。因此 `TG_STREAM_EDIT_MS=0` 时 Telegram 的行为与打补丁前**完全一致**（含上游请求形态）。

> 副作用：正式回复是「编辑」出来的，Telegram 会在消息上标一个「edited」。这是流式机器人的常态，
> 想彻底避免就设 `TG_STREAM_EDIT_MS=0`。

## p1-4 修复 Telegram「Agent 思考中…然后就没反应了」

**根因不是网络，是整轮耗时越过了 Telegram 的 60 秒红线。** Telegram 的 webhook 客户端约 60 秒就断开，
而**客户端断开后 Cloudflare 会把 worker 一起 cancel** —— 收尾消息根本发不出去，用户就永远停在
「🤖 Agent 思考中（第 N 步）…」上。默认预算原本是 55 秒，看着很安全，但实际有四处会让整轮超出去：

| 漏洞 | 原来的行为 | 最坏影响 |
|---|---|---|
| 预算贴着 60 秒 | 默认 55 秒，没有为收尾动作留余量 | 收尾本身就跑到红线外 |
| **降级重试各自算预算** | 首步带工具失败 → `runAgentTurn(false)` 是**第二次** `tgAgentChat`，`tgAgentDeadline()` 又被调用一次 → 预算翻倍 | 55s + 55s = 110s |
| 上游超时有 15 秒下限 | `Math.max(15000, remainMs)`：临近 deadline 的一步还能再多跑 15 秒 | 55s + 15s = 70s |
| 工具超时不受预算约束 | `execAgentTool` 固定 30 秒，与 deadline 无关 | 55s + 30s = 85s |

修复：

- **整轮共享一个硬墙钟**：由 webhook 侧算一次，经 `opts.deadline` 传进 `tgAgentDeadline()`。
  两次 `tgAgentChat`（带工具 + 降级重试）共用同一个 deadline，预算不再翻倍。
- **收尾预留**：`TG_WEBHOOK_RESERVE_MS`（默认 6 秒，最多占预算 1/4）从 Agent 可用时间里扣掉。
  默认预算同时从 55 秒降到 **45 秒**。
- **上游超时不再有下限**：单步超时 = 剩余预算；剩余不足 2 秒时直接暂停，不再起一次注定超时的调用。
- **工具超时压进剩余预算**：`execAgentTool(name, args, env, chatId, budgetMs)`。
  注意这里仍然是"跑 + 超时返回提示"，**不能直接跳过** —— assistant 的 `tool_calls` 必须配齐
  tool 结果，否则暂停存档的消息序列非法，续做会失败。
- **进度 / 流式编辑用 5 秒短超时**：`tgApi` 默认 15 秒对最终回复合适，但对进度编辑太长，
  Telegram 偶发卡两次就是 30 秒。

实测（把预算等比缩到 12 秒跑最坏场景，`tests-local/tg-budget.mjs`）：

| 场景 | 打补丁前 | 打补丁后 | 预算 |
|---|---|---|---|
| 上游一直挂着 | 15047ms | 10010ms | 12000ms |
| 降级重试后上游挂着 | 15207ms | 10002ms | 12000ms |
| 慢 400 后再降级重试 | 23005ms | 8004ms | 12000ms |
| 工具后端 hung 住 | 12005ms | 10002ms | 12000ms |

打补丁前最多超出预算 92%（23 秒 / 12 秒）—— 换成真实的 45 秒预算就是 86 秒，远超 60 秒红线。
打补丁后全部落在预算内。

> 代价：预算从 55 秒降到 45 秒，长任务会更早暂停、需要发「继续」接着做。
> 这是刻意的取舍 —— **一个明确的"已暂停，发继续"远比一句永远转圈的"思考中"好**。
> 想放宽可以调大 `TG_WEBHOOK_BUDGET_MS`，但请保持在 60 秒以内并留够余量。

---

# 附：版本更新记录

- **v6.8.7**（打磨）：限流 `clear()` 改淘汰最旧条目 + 过期 key 删除（高并发下不再 fail-open）；DSML 参数解析容忍 `max_tokens` 截断（最后一个参数不再静默丢失）；工具结果截断不在 emoji 代理对中间切断；上游错误响应体带 2KB 预算读取；Telegram 更新处理异常时删除去重标记以便重发重试。
- **v6.8.6**（全量审计修复 25 项）：SSRF 三洞（重定向逐跳校验、IPv4 映射 IPv6 压缩形式、FQDN 尾点）、`web_fetch` 流式读取防 OOM、天气查询超时、计算器溢出、DDG 解析错位、记忆删除索引校验、历史成对裁剪、「继续」精确匹配、群组 `@botname` 命令兼容、前端 CDN 降级等。
- **v6.8.5**：修复 Telegram 进度"假卡死"——步骤标签与工具进度改用独立节流通道。
- **v6.8.4**：修复知识库"已保存但查不到"——注册表写入后校验 + 重试，注册表降级为缓存、读取时自动比对重建。
- **v6.8.8**（知识库写入可信度加固）：`storePutChecked` 名副其实——put 后立即读回校验（存在性 + UTF-8 字节大小一致），读不到就判失败，杜绝"说已保存但 R2 里没有"的最后一丝可能；失败消息给出 bucket 绑定排查指引；成功消息自带"已从 R2 读回校验"字样；系统提示词明确"没看到这句成功消息一律按失败处理"，防 LLM 美化失败。

# Cloudflare-Chat

基于 Cloudflare Workers 的多通道 AI 对话前端 + Telegram 机器人。单文件 Worker（`_worker.js`），通过 `wrangler.toml` 声明式配置，支持连接 GitHub 仓库自动构建部署。

> 当前版本：**v6.6.3**（见下方更新日志）

## v6.6.3 更新日志

- **修复 R2 文件无上限堆积**：v6.4.3 引入的 `update_id` 去重每次都在 R2 新建一个 `tg_update_<update_id>` 对象且永不删除（每条 Telegram 消息 +1 个文件）。v6.6.3 起去重改用**内存 Map**（10 分钟窗口，过期条目每次顺手清理），不再写 R2
  - 附带一次性清理脚本 `cleanup-tg-update-keys.sh`，用 `wrangler r2 object` 按前缀批量删除历史堆积的 `tg_update_*` 对象（默认 dry-run，先看数量再确认删除）
  - 注意：内存去重在极端跨实例重发下可能漏判一次（退化为 v6.4.3 之前的行为），属于可接受的折中

## v6.6.2 更新日志

- **删除 Web 对话时同步清理 R2 记忆**：删除会话会调用新增的 `DELETE /api/web-memory?session_id=xxx`，把该会话的 Agent 长期记忆（`agent_mem_web_<sessionId>`）从 R2 删除，**内存缓存也一起清**（否则下次 `remember` 会把删掉的记忆复活写回去）
  - session_id 经过严格清洗 + `web_` 前缀强制隔离，路径遍历攻击无法误删别人的 key
  - 删除失败不影响本地会话删除

## v6.6.1 更新日志

- **网页右上角版本号同步**：之前硬编码的 "Pro v6.0" 改为服务端注入 `APP_VERSION`，以后每次发版自动同步，不用再手动改

## v6.6.0 更新日志

- **Web 端也能用 Agent 了**：输入框旁新增 "🤖 Agent" 开关（默认开启，状态记 localStorage），与 Telegram 共用同一套 ReAct 循环 + 6 个零密钥工具（🔍 搜索 / 📄 网页 / 🧮 计算 / 🌤 天气 / 🕐 时间 / 🧠 长期记忆）
  - 工具执行进度实时显示在气泡内（"🔍 正在搜索：xxx"），完成后自动消失
  - 长期记忆按 Web 会话隔离（`web_<sessionId>`），与 Telegram 记忆互不干扰
  - Web 是浏览器长连接（无 Telegram 的 60 秒重发问题），直接用完整 `AGENT_TIMEOUT_MS` 预算，不做断点续做
  - Agent 模式下不自动重试（避免重复执行工具）；执行错误红色展示且不记入历史
  - 图片生成通道不受影响，仍走旧链路

## v6.5.0 更新日志

- **Agent 断点续做**：webhook 单轮预算约 55 秒（Telegram 约 60 秒无响应会重发 update；客户端断开后 worker 会被官方 cancel，靠加预算赌长连接是不可靠的）。超预算的任务不再直接终结，而是**暂停并保存进度到 R2**，用户发「继续」即用全新预算接着跑 —— "抓链接详细分析"这类长任务分几段也能做完
  - 预算耗尽、推理步数用尽时都会保存断点；「继续」可跨多轮接力；断点 30 分钟过期；新问题或 `/clear` 自动丢弃旧断点
  - 新增环境变量 `TG_WEBHOOK_BUDGET_MS`（默认 55000，可设 10000 ~ 240000）
- `/help` 增加「继续」说明；显示 v6.5.0

## v6.4.4 更新日志

- **修复"网络错误：The operation was aborted due to timeout"误报**：`AbortSignal.timeout()` 抛的是 `TimeoutError` 而非 `AbortError`，之前被误判为网络故障。更重要的是归因逻辑：中断发生时用整体 deadline 区分 —— 如果是**我们自己的 55 秒 webhook 预算耗尽**（比如上游深度思考太慢），现在返回可见的"（本次任务超时，已停止）"+ 已有进展，而不是吓人的"网络错误"；只有预算充足时上游真 hung 住，才提示"上游响应超时"
- `/help` 显示 v6.4.4

## v6.4.3 更新日志

- **根因修复 Agent 长任务静默被掐断**：之前收到 Telegram webhook 立刻返回 OK、把全部工作丢进 `ctx.waitUntil`，但 HTTP 响应结束后 `waitUntil` 最多再延续约 30 秒 —— 超过 30 秒的 Agent 任务会被无声终止，pending 消息永远卡在"📄 正在读取网页…"。现在改为**在请求上下文内等待处理完成再返回 OK**，彻底告别 30 秒天花板
- **webhook 内 Agent 预算 55 秒**：保证在 Telegram 因响应超时重发 update 之前返回；超时不再静默卡死，而是返回"（本次任务超时，已停止）"+ 已有进展
- **`update_id` 去重**：同一 update 10 分钟内只处理一次，防止 Telegram 重发导致重复执行 / 重复回复（R2 未绑定时自动跳过）
- **Telegram API 调用超时**：`tgApi` 增加 `AbortSignal` 超时（默认 15 秒，可用 `TG_API_TIMEOUT_MS` 调整），`api.telegram.org` 偶发 hung 住不再拖死整个流程；最终回复发送失败自动重试一次
- **typing 心跳**：Agent 运行期间每 20 秒刷新一次"正在输入…"，长推理/长工具调用用户侧一直有反馈；结束时自动清理定时器
- **单步 LLM 超时与整体预算联动**：单次上游调用超时取 3 分钟与整体剩余预算的较小值
- **`/help` 显示版本号**：方便确认线上部署的版本
- 普通对话模式的上游调用也加上 60 秒超时

## v6.4.2 更新日志

- **修复 Agent 卡死无响应**：某步工具执行异常 hung 住（如抓取到永不结束的流式响应）或内部抛错时，之前会静默卡死在"思考中"，现在三层防护：
  1. 调用方加 try/catch，任何未预期异常都转为可见的错误提示，不再 frozen
  2. 每个工具增加独立竞速超时（默认 30 秒，可通过 `AGENT_TOOL_TIMEOUT_MS` 调整），abort 信号中断不了的 hung 住也能被救回来
  3. 畸形 tool_call（含缺失 function 字段）不再抛错导致整个 Agent 崩溃，而是跳过继续
- **每步开始报进度**：LLM 长思考时也能看到"第 N 步"活着；工具进度用 force 标记突破 1.5 秒节流

## v6.4.1 更新日志

- **长期记忆彻底不限条数**：删除 2000 条保护性上限，R2 单对象可达 5TB；每次 prompt 仍按 6000 字符预算注入，条数增长不增加 token 成本
- **相关性打分优化**：记忆分词改用 Set 查找（O(1)），记忆量再大也不会变慢

## v6.4.0 更新日志

- **Agent 可视化**：工具执行时实时把进度编辑到"思考中"消息上（`🔍 正在搜索：xxx` / `📄 正在读取网页…` / `🧮 正在计算…` 等），不再黑盒等待；带 1.5 秒节流，避免触发 Telegram 编辑限流
- **工具并行执行**：同一步的多个工具调用并发执行（结果按序写回），"对比两地天气"这类任务明显更快
- **搜索结果带摘要**：联网搜索返回标题 + 链接 + 摘要，模型更容易判断抓哪条深入读
- **记忆相关性注入**：长期记忆不再只按最新注入，而是按"与本次提问的相关性 + 新近度"排序后按 6000 字符预算注入，2000 条记忆也能精准召回
- **记忆管理命令**：`/memory` 查看全部长期记忆、`/forget 关键词` 删除记忆、`/help` 查看命令列表
- **运行护栏**：总超时（默认 4 分钟）、单次 LLM 调用超时（3 分钟）、步数上限（默认 6，最大 12），均可通过环境变量 `AGENT_TIMEOUT_MS` / `AGENT_MAX_STEPS` 调整
- **系统提示词强化**：意图判断、工具选择策略、多步规划、输出格式要求更明确


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

**持久化首选 R2**：KV 免费版每天只有 1000 次写入、单 key 限 1 次写入/秒，而机器人每轮对话都要写历史、Agent 记忆也在增长，很容易撞墙。R2 无日写入上限（免费版每月 100 万次 A 类操作）、单对象可达 5TB、读写强一致。**不需要去控制台手动创建 bucket，也不需要手动添加绑定。** `wrangler.toml` 中已这样声明：

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

**工作方式**：ReAct 循环 —— 模型先判断意图，简单问题直接回答；需要时自主规划多步（比如先搜索再抓取原文、先计算再汇总），最多 6 步，工具结果回填后综合作答，绝不编造。

**记忆**：短期记忆是多轮对话历史；长期记忆是你明确告知的事实，每次对话自动注入，无需重复介绍自己。

**命令**：
- `/agent` —— 在 Agent / 普通对话模式间切换（选择保存在 R2，默认 Agent 开启）
- `/model` —— 切换模型；`/clear` —— 清空上下文
- `/memory` —— 查看长期记忆；`/forget 关键词` —— 删除记忆；`/help` —— 命令列表

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
| 离线提示 | 顶部橙色横幅，断网时滑入，恢复后自动滑出 |

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
- **`/tg-webhook` 来源校验**：配置 `TG_WEBHOOK_SECRET` 后，只接受 `setWebhook` 时传入相同 `secret_token` 的请求。未配置时保持开放（兼容旧部署），公开使用时强烈建议配置。
- **AI 回复经 XSS 清洗**：前端所有 AI 生成内容先经 Markdown 渲染，再过 DOMPurify 白名单清洗后才插入页面；CDN 加载失败时降级为纯文本显示。
- **CORS 为 `*`**：`Access-Control-Allow-Origin: *` 允许任意站点调用你的接口。如果只在自己的域名下使用，建议收紧为实际域名。
- **API Key 只存在于服务端**：密钥通过环境变量注入，不会下发到浏览器，前端只能看到模型名称。

> 关于口令强度的说明：口令以明文形式保存在浏览器 localStorage 中，并通过请求头传输（HTTPS 加密）。服务端比较采用定长实现，可避免通过响应耗时逐字节猜解。它能有效挡住扫描器和随手调用接口的人，但不宜作为对抗定向攻击的唯一防线。

---

# 附：新增环境变量一览（v6.1.0 起）

| 变量 | 说明 | 默认值 |
|---|---|---|
| `TG_WEBHOOK_SECRET` | Telegram webhook 校验密钥，见第四步 | 未配置=不校验 |
| `TG_HISTORY_ROUNDS` | 机器人记住的最近对话轮数（最大 30） | `10` |
| `MAX_TOKENS` | `/api/chat` 与机器人共用的 `max_tokens`（上限 32000） | `4096` |
| `RATE_LIMIT_PER_MIN` | 每 IP 每分钟 `/api/chat` 限额，`0` 关闭 | `60` |
| `AGENT_MAX_STEPS` | Agent 单轮任务最大推理步数（上限 12） | `6` |
| `AGENT_TIMEOUT_MS` | Agent 单轮任务总超时（毫秒） | `240000`（4 分钟） |
| `AGENT_TOOL_TIMEOUT_MS` | 单个工具最长执行时间（毫秒） | `30000`（30 秒） |
| `TG_API_TIMEOUT_MS` | Telegram Bot API 单次调用超时（毫秒） | `15000`（15 秒） |
| `TG_WEBHOOK_BUDGET_MS` | webhook 内 Agent 单轮预算（毫秒），10 秒 ~ 240 秒 | `55000`（55 秒） |

---

# 附：杂项说明

- **`tts-demo.html`**：朗读功能的独立演示页，**Worker 不提供对应路由**，直接在浏览器本地打开即可查看，不参与部署。
- **`/a9a015a0f6e7c9ca09f4cdce4479deb3.txt`**：域名所有权验证文件（第三方平台验证用），内容固定；确认不再需要时可删除 `_worker.js` 中对应路由。

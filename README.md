# Cloudflare-Chat

基于 Cloudflare Workers 的多通道 AI 对话前端 + Telegram 机器人。单文件 Worker（`_worker.js`），通过 `wrangler.toml` 声明式配置，支持连接 GitHub 仓库自动构建部署。

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
> `package.json` 中锁定了 `wrangler ^4.0.0`，请勿删除 —— Workers Builds 会优先使用这里声明的 Wrangler 版本，版本过旧会导致下面的 KV 自动置备失败。

---

# 第二步：KV 命名空间（自动创建 + 自动绑定，无需手动操作）

**不需要去控制台手动创建 KV，也不需要手动添加绑定。** `wrangler.toml` 中已这样声明：

```toml
[[kv_namespaces]]
binding = "KV"
```

这里**故意省略了 `id`**。省略 `id` 会触发 Wrangler 的 **Automatic Provisioning（自动资源置备）**：

- 部署时自动在账号下创建一个 KV 命名空间，命名规则为 `<Worker 名>-<binding 名小写>`，即 **`cloudflare-chat-kv`**；
- 自动将其绑定到 Worker，代码中通过 `env.KV` 访问；
- 该命名空间的 `id` **不会写回仓库**，只存在于 Cloudflare 控制台。

### 如何确认成功了

部署完成后，在构建日志中应当能看到：

```
The following bindings need to be provisioned:
Binding   Resource
env.KV    KV Namespace

🌀 Creating new KV Namespace "cloudflare-chat-kv"...
✨ KV provisioned 🎉
```

同时可以到 **Workers & Pages → KV** 确认命名空间已存在，并在 Worker 详情页的 **Bindings** 中看到 `KV`。

### 建议：首次部署后回填 id（可选但推荐）

首次部署成功后，进入 **Workers & Pages → KV**，复制 `cloudflare-chat-kv` 的 id，填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "KV"
id = "把复制到的 id 粘贴到这里"
```

这样后续部署完全确定，不再依赖置备逻辑，也便于在多个环境间保持一致。

### 如果不需要 KV

KV 仅用于 Telegram 机器人记住每个用户选择的模型。代码中所有 KV 调用都有 `if (env.KV)` 保护，**缺少绑定时不会报错**，只是机器人重启后用户的模型选择会回到默认值。若不需要，可整段删除 `wrangler.toml` 中的 `[[kv_namespaces]]` 配置。

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

# 第四步：启用 Telegram 机器人（可选）

1. 在 @BotFather 处创建机器人，拿到 Bot Token。
2. 在 Worker 的 **设置 → 变量和机密** 中添加 `TG_BOT_TOKEN`。
3. 重新部署，然后设置 Webhook：

```
https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=https://<你的Worker域名>/tg-webhook
```

配置完成后，在 Telegram 中向机器人发送 `/start` 或 `/model` 即可通过内联按钮切换模型。用户的模型选择会通过第二步自动创建的 KV 持久化保存。

---

# 常见问题

**部署日志报 `Missing id` 或要求交互式输入**

构建环境使用的 Wrangler 版本过旧，不支持自动置备。确认仓库根目录存在 `package.json` 且其中声明了 `wrangler ^4.0.0`。若仍失败，改用第二步的「回填 id」方案：手动创建一个 KV 命名空间，把 id 写进 `wrangler.toml`。

**部署日志报 `Binding at index N must have a name [code: 10052]`**

`wrangler.toml` 里的 `binding` 是空字符串。binding 名不能为空，必须是 `KV`。注意这个错误还会在账号里留下一个名字畸形的孤儿命名空间，需要手动去 KV 页面删掉。

**页面一直提示 API 错误 / 模型下拉框是空的**

如果下拉框显示「未配置模型，请检查环境变量」，说明 Worker 没有读到任何模型配置：检查 `API_URL_1` / `API_KEY_1` / `MODEL_1` 三件套是否齐全、编号是否从 1 开始连续，以及改完变量后是否重新部署过。

注意 `MODEL_1` 只有和 `API_URL_1` 同时存在时才会生效 —— 只填模型名不填接口地址不会产生任何模型。

如果下拉框有模型但对话报错，多半是 `API_KEY_1` 没填或填错，可以在 Cloudflare 的实时日志（Workers & Pages → 你的 Worker → Logs）里看到上游接口返回的具体报错。

**每次部署都会重复创建 KV 命名空间**

去 KV 页面确认是否出现多个同名或相似名字的命名空间。若有，删除多余的，并按第二步「回填 id」的方式把正确的 id 固定到 `wrangler.toml` 中。

**改了环境变量但前端模型列表没更新**

`wrangler.toml` 的 `keep_vars = true` 只保证变量不被清空，不会让改动立即生效。需要在 **设置 → 变量和机密** 修改后重新触发一次部署。

---

# 安全提示

当前实现中，`/api/chat` 接口为 `Access-Control-Allow-Origin: *` 且**没有任何鉴权**。任何拿到 Worker 域名的人都可以调用它并消耗你配置的 API 额度。`/tg-webhook` 也未校验 Telegram 的 secret token。

如果部署在公开可访问的域名上，建议至少做以下一项加固：

- 为 `/api/chat` 增加访问口令校验（前端带一个自定义 Header，后端比对环境变量）；
- 把 CORS 的 `*` 收紧为你实际使用的域名；
- 在 `setWebhook` 时带上 `secret_token` 参数，并在 Worker 中校验 `X-Telegram-Bot-Api-Secret-Token` 请求头。

# 第一步：在 Cloudflare 中导入 Git 存储库部署
登录你的 Cloudflare 控制台。

在左侧导航栏选择 "Workers & Pages"。

点击 "创建应用程序" (Create application)。

切换到 "Workers" 选项卡。

找到并点击 "连接到 Git" (Connect to Git) 按钮。

按照提示授权绑定你的 GitHub 账号。

在仓库列表中，选择你刚刚创建的 ai-proxy-worker 仓库。

默认的构建设置会被 wrangler.toml 自动接管，直接点击 "保存并部署" (Save and deploy)。

# 第二步：配置环境变量（关键）
从你提供的代码逻辑来看，这个项目高度依赖环境变量来配置 API 和模型。部署成功后，必须在 Cloudflare 中填入这些变量，否则页面会提示 API 错误。

在 Cloudflare 中进入刚部署好的 Worker 项目页面。

点击 "设置" (Settings) -> "变量和机密" (Variables and Secrets)。

在 "环境变量" 区域点击 "添加"。

根据你的代码逻辑，你需要添加以下配置（选择其中一种方式即可）：
### 多模型/多通道配置（你在代码中新增的功能）

变量名 API_URL_1 / 变量值：通道 1 的 API 地址

变量名 API_KEY_1 / 变量值：通道 1 的密钥

变量名 MODEL_1 / 变量值：gpt-4o:GPT-4o, gpt-3.5-turbo:GPT-3.5

(注：如果你还想启用 Telegram 机器人功能，请添加 TG_BOT_TOKEN 环境变量)

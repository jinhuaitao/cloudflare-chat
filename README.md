# 第一步：在 Cloudflare 中导入 Git 存储库部署
登录你的 Cloudflare 控制台。

在左侧导航栏选择 "Workers & Pages"。

点击 "创建应用程序" (Create application)。

切换到 "Workers" 选项卡。

找到并点击 "连接到 Git" (Connect to Git) 按钮。

按照提示授权绑定你的 GitHub 账号。

在仓库列表中，选择你刚刚创建的 cloudflare-chat 仓库。

默认的构建设置会被 wrangler.toml 自动接管，直接点击 "保存并部署" (Save and deploy)。

# 第二步：配置环境变量（关键）

### 1

打开 Cloudflare 控制台 -> KV Namespaces -> 创建一个叫 TG_KV 的命名空间。

进入你的 Worker 脚本设置 -> Settings -> Variables -> KV Namespace Bindings。

添加绑定：Variable name 填 KV，KV Namespace 选择刚创建的 TG_KV。

### 2
从你提供的代码逻辑来看，这个项目高度依赖环境变量来配置 API 和模型。部署成功后，必须在 Cloudflare 中填入这些变量，否则页面会提示 API 错误。

在 Cloudflare 中进入刚部署好的 Worker 项目页面。

点击 "设置" (Settings) -> "变量和机密" (Variables and Secrets)。

在 "环境变量" 区域点击 "添加"。

根据你的代码逻辑，你需要添加以下配置（选择其中一种方式即可）：
### 多模型/多通道配置（你在代码中新增的功能）

##### 直接填写你想要使用的模型，多个模型用英文逗号 , 隔开，格式为 模型ID:显示名称。

变量名 API_URL_1 = 变量值：通道 1 的 API 地址

变量名 API_KEY_1 = 变量值：通道 1 的密钥

变量名 MODEL_1 = 变量值：模型:自定义模型名,模型:自定义模型名

#### 通道 1 (例如对接 OpenAI):
API_URL_1 = https://api.openai.com/v1/chat/completions

API_KEY_1 = sk-xxxxxx

MODEL_1 = gpt-4o:GPT-4o, gpt-4o-mini:GPT 4o Mini

#### 通道 2 (例如对接 阿里通义千问):

API_URL_2 = https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions

API_KEY_2 = sk-yyyyyy

MODEL_2 = qwen-plus:通义千问 Plus, qwen-max:通义千问 Max

### 添加完所需的环境变量后，必须重新部署一次，新的模型列表就会出现在前端的下拉框里了。

# 第三步（可选）：接入 Agnes Video 2.5 Flash 视频生成

视频通道复用同一套通道变量，把"创建任务"的地址填进 API_URL 即可，Worker 会按模型名或地址自动识别为视频通道（也可在 API_CONFIG 里用 "type": "video" 显式声明）。

#### 通道 3 (对接 Agnes 视频):

API_URL_3 = https://apihub.agnes-ai.com/v1/videos

API_KEY_3 = 你的 Agnes 密钥

MODEL_3 = agnes-video-2.5-flash:Agnes 视频 Flash

等价的 API_CONFIG 写法（一个 JSON 数组）：

```json
[
  {
    "url": "https://apihub.agnes-ai.com/v1/videos",
    "keys": ["sk-xxxxxx"],
    "type": "video",
    "models": ["agnes-video-2.5-flash:Agnes 视频 Flash"]
  }
]
```

重新部署后，在前端下拉框选中该模型，输入框上方会出现一条视频参数栏：

| 参数 | 取值 | 说明 |
| - | - | - |
| 时长 | 4–12 秒 | 默认 5 秒，对应接口的 `seconds` |
| 画幅 | 16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9 | 输出分辨率固定 720P，像素由画幅决定（如 16:9 为 1280x704） |
| 模式 | 文生视频 / 首尾帧 / 素材参考 | 对应 `mode`: `text` / `keyframe` / `reference` |

首尾帧模式在素材栏填 `首帧URL` 或 `首帧URL,尾帧URL`；素材参考模式填图片/音频 URL，逗号分隔，`.mp3 .wav .m4a .aac .ogg .flac` 会被归为音频，其余归为图片。提示词里可用 `<Picture 1>`、`<Audio 1>` 指代第 1 个素材。所有素材地址必须公网可访问。

# 生成流程与超时续查

1. Worker `POST /v1/videos` 创建任务，拿到 `video_id`。
2. Worker 在同一条 SSE 流里每 `VIDEO_POLL_INTERVAL` 秒查询一次 `https://apihub.agnes-ai.com/agnesapi?video_id=...&model_name=...`，并把进度推给前端，最长等待 `VIDEO_POLL_TIMEOUT` 秒。
3. 若超过上限仍未完成（Worker 单请求不宜长挂），Worker 把 `video_id` 交回浏览器，前端每 3 秒调用一次 `/api/video_task` 继续查询。刷新页面或切换会话后会自动续查，任务不会丢失；完成后视频直接渲染在对话气泡里，并附下载链接。

可选环境变量（不填则用默认值）：

VIDEO_POLL_INTERVAL = 3（秒，取值范围 1–30）

VIDEO_POLL_TIMEOUT = 170（秒，取值范围 10–600）

Flash 的限制（`size` 固定 720P、图片 ≤ 5 张、音频 ≤ 3 段、不支持 `videos` 参考、`seconds` 为字符串 4–12、`n` 固定 1）已在 Worker 本地校验，不合法的请求不会发往 Agnes、也不会创建任务；具体错误原因会直接显示在聊天气泡中。API 密钥只在 Worker 侧使用，不会下发到浏览器。

Telegram 通道不支持异步视频任务，选中视频模型时会提示改用网页端。

# (注：如果你还想启用 Telegram 机器人功能，请添加 TG_BOT_TOKEN 环境变量)

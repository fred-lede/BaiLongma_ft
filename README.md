![Bailongma](https://github.com/xiaoyuanda666-ship-it/BaiLongma/blob/main/images/AGI128k.jpg)

# Bailongma

Bailongma 是一个持续运行的桌面 AI Agent 项目。它不是一次问答结束就退出的聊天程序，而是由主循环驱动：有用户消息时优先处理，空闲时按节奏继续整理记忆、检查任务、刷新上下文，并把状态实时推送到 Brain UI。

项目由 Electron 桌面壳、本地 HTTP 服务、LLM 调用层、记忆系统、工具执行器、语音系统、社交连接器和 Brain UI 组成。它的目标是让一个本地 Agent 既能聊天，也能记住、行动、观察自己的运行状态，并通过工具完成文件、网页、媒体、提醒、任务和系统级操作。

## 主要能力

- 持续运行的主循环：处理用户消息、后台消息、提醒、任务续跑和空闲心跳。
- 记忆系统：基于本地 SQLite 持久化对话、记忆、行动日志、提醒、预取缓存、媒体历史和线程状态，并支持全文检索、语义补充、去重与合并。
- 动态上下文注入：每轮对话前自动选择相关记忆、最近对话、用户画像、工具结果、UI 信号、预取内容和运行状态。
- 多模型接入：通过 OpenAI 兼容接口连接 DeepSeek、MiniMax、OpenAI、Qwen、Moonshot、Zhipu、MiMo 以及自定义服务。
- 工具系统：按需注入工具，支持通信、文件系统、Shell、网页读取、搜索、媒体生成、记忆管理、UI 卡片、任务、提醒、本地 Agent 委托和系统操作。
- Brain UI：提供聊天、思考流、记忆图、焦点线程、热点面板、文档面板、人物卡片、语音控制、设置页和 ACUI 卡片渲染。
- 语音能力：支持云端 ASR（阿里云百炼、腾讯云、科大讯飞、火山引擎）和本地 ASR（AetherMesh Whisper），TTS 支持豆包语音合成 2.0、MiniMax、OpenAI、ElevenLabs、火山引擎基础版、自定义 OpenAI 兼容服务和 AetherMesh 语音克隆（XTTS-v2 等本地模型），可在 UI 中配置语音输入、语音输出和声音参数。支持逐人语音偏好，可在人物卡片中为每个角色指定独立的 TTS 语言和音色。
- 社交连接器：支持 Discord、微信和 Telegram 桥接，外部消息进入同一个主循环，回复按渠道路由返回。
- 本地资源感知：启动时收集系统信息、桌面信息、已安装软件、本地 Agent、SSH 与 Git 资源、地理天气和热点内容。
- 桌面集成：Electron 窗口、托盘、自动更新状态、日志落盘、单实例运行和焦点横幅。

## 项目结构

```text
electron/              Electron 主进程、预加载脚本和桌面窗口控制
src/index.js           Agent 主循环、调度、任务状态和启动流程
src/api.js             本地 HTTP 服务、SSE、WebSocket、设置和管理接口
src/llm.js             LLM 流式调用、工具调用执行和重试保护
src/config.js          Provider、模型、语音、社交、搜索和安全配置
src/db.js              SQLite 数据表、索引和持久化读写
src/memory/            记忆识别、注入、线程、焦点、召回和整理
src/context/           运行时上下文、规则、关键词和片段选择
src/capabilities/      工具 schema、执行器、沙箱和工具市场
src/social/            社交平台连接器和消息路由
src/voice/             云端 ASR、TTS 服务和语音相关逻辑
src/ui/brain-ui/       Brain UI 前端、ACUI 组件和可视化面板
scripts/               构建、探测、修复、冒烟测试和辅助脚本
sandbox/               Agent 工作区与生成内容存放区
data/                  本地运行数据，打包时不会带入安装包
```

## 运行方式

先安装依赖：

```bash
npm install
```

启动桌面应用：

```bash
npm start
```

只启动本地后端：

```bash
npm run start:backend
```

开发时自动重启后端：

```bash
npm run dev
```

需要局域网访问时，可以使用仓库里已有的启动脚本：

```bash
npm run start:lan
npm run start:backend:lan
```

## 配置

首次启动后会进入激活页，填写任意已支持 Provider 的 API Key 即可。也可以通过 `.env` 提供环境变量：

```env
LLM_PROVIDER=minimax
MINIMAX_API_KEY=your_key
```

常用配置可以在 Brain UI 的设置页中完成：

- 模型 Provider、模型、温度和 API Key。
- 语音识别、TTS Provider、音色和凭证。
- 社交平台连接参数。
- 嵌入、网页搜索和安全开关。
- Agent 名称、UI 行为和媒体相关偏好。

配置会持久化到本地数据目录。敏感设置接口默认只允许本机访问；需要远程访问时应结合环境变量开启局域网访问或设置 API Token。

## Web 入口

本地服务默认监听：

```text
http://127.0.0.1:3721
```

常用页面：

| 页面 | 地址 | 用途 |
| --- | --- | --- |
| Brain UI | `/brain-ui` | 主界面、聊天、状态、设置和可视化 |
| 激活页 | `/activation` | 首次配置 API Key |
| 运行状态 | `/status` | 查看循环、任务和记忆概览 |
| 配额状态 | `/quota` | 查看当前请求与限流状态 |
| Turn Trace | `/turn-trace` | 查看回合级运行轨迹 |

如果 Electron 启动时默认端口被占用，主进程会自动寻找可用端口并加载对应地址。

## 常用 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/message` | 发送一条用户消息到主循环 |
| `GET` | `/events` | 订阅 SSE 事件流 |
| `GET` | `/status` | 获取运行状态 |
| `GET` | `/quota` | 获取配额与限流信息 |
| `GET` | `/memories` | 查询记忆 |
| `PATCH` | `/memories/:id` | 更新记忆 |
| `DELETE` | `/memories/:id` | 删除记忆 |
| `GET` | `/conversations` | 查询最近对话 |
| `GET` | `/settings` | 获取设置摘要 |
| `POST` | `/activate` | 写入 Provider 配置并激活 |
| `POST` | `/settings/model` | 切换模型 |
| `POST` | `/settings/temperature` | 调整温度 |
| `GET` | `/settings/voice` | 获取语音识别设置 |
| `POST` | `/settings/voice` | 保存语音识别设置 |
| `GET` | `/settings/tts` | 获取 TTS 设置 |
| `POST` | `/settings/tts` | 保存 TTS 设置 |
| `POST` | `/tts/stream` | 流式生成语音 |
| `GET` | `/social/wechat-clawbot/qr` | 获取微信桥接二维码状态 |
| `POST` | `/social/wechat-clawbot/logout` | 退出微信桥接 |
| `POST` | `/admin/stop` | 暂停主循环 |
| `POST` | `/admin/start` | 恢复主循环 |
| `POST` | `/admin/restart` | 重启应用进程 |
| `POST` | `/admin/reset-memories` | 清空记忆和对话 |
| `POST` | `/admin/reset-files` | 清空沙箱文件 |

部分接口还用于 Brain UI 内部面板，例如热点、文档、人物卡片、媒体历史、AI 视频面板、ACUI 和云端语音识别。

## 图像生成

Bailongma 通过 AetherMesh 连接 Ollama 上的 `x/z-image-turbo:bf16` 模型实现本地文生图，也支援 OpenAI 格式的任何图像生成服務。

### 架构

```text
用户输入 "画一张..." → LLM 调用 generate_image 工具
  → Provider 注册表路由到 AetherMeshImageProvider
  → POST {aethermeshBaseURL}/v1/images/generations（OpenAI 兼容格式）
  → 收到 b64_json → 持久化到本地 → 回传 URL → 前端显示
```

### 配置

无需额外设定。图像生成共用 AetherMesh 的 baseURL 和 key（来自 TTS/Voice 配置）：

```json
{
  "voice": {
    "aethermeshBaseURL": "http://192.168.1.200:8001",
    "aethermeshKey": "your-api-key"
  }
}
```

配置可在 Brain UI 的设置面板中完成（TTS 或 ASR 页签），或直接编辑 `config.json`。

### 在聊天中使用

在 Brain UI 聊天输入框输入以下触发词，AI 会自动调用图像生成：

- 中文：`画一张...`、`画个...`、`帮我画...`、`生成图片...`、`配图...`
- 英文：`draw...`、`paint...`、`generate image of...`、`picture of...`

支援的尺寸比例：`1:1`、`16:9`、`4:3`、`3:4`、`9:16`，每次最多 4 张。

### API 调用（程式开发）

#### 通过聊天接口（AI 自动路由）

```bash
curl -X POST http://127.0.0.1:3721/message \
  -H "Content-Type: application/json" \
  -d '{"content": "画一张山水画，16:9", "from_id": "external"}'
```

AI 收到后会解析意图，自动调用 `generate_image` 工具，结果会通过 SSE 事件 `image_created` 推送：

```json
{
  "type": "image_created",
  "data": {
    "urls": ["/media/chat/abc123.png"],
    "prompt": "山水画",
    "aspect_ratio": "16:9",
    "n": 1
  }
}
```

#### 直接调用 AetherMesh（不经过 LLM）

AetherMesh 提供 OpenAI 兼容的 `/v1/images/generations` 端点，任何语言的 OpenAI SDK 均可使用：

```bash
curl -X POST http://192.168.1.200:8001/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "x/z-image-turbo:bf16",
    "prompt": "a cute cat, digital art",
    "n": 1,
    "size": "1024x1024",
    "response_format": "b64_json"
  }'
```

响应：

```json
{
  "created": 1710000000,
  "data": [
    { "b64_json": "<base64-encoded-image-data>" }
  ]
}
```

Python 示例：

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://192.168.1.200:8001/v1",
    api_key="your-api-key"
)

response = client.images.generate(
    model="x/z-image-turbo:bf16",
    prompt="a cute cat, digital art",
    n=1,
    size="1024x1024",
    response_format="b64_json"
)

# b64_json → 存檔
import base64
for item in response.data:
    img_data = base64.b64decode(item.b64_json)
    with open("output.png", "wb") as f:
        f.write(img_data)
```

JavaScript 示例：

```javascript
const response = await fetch("http://192.168.1.200:8001/v1/images/generations", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "x/z-image-turbo:bf16",
    prompt: "a cute cat, digital art",
    n: 1,
    size: "1024x1024",
    response_format: "b64_json",
  }),
})
const { data } = await response.json()
const buffer = Buffer.from(data[0].b64_json, "base64")
require("fs").writeFileSync("output.png", buffer)
```

支援的尺寸参数：

| aspect_ratio | size |
|---|---|
| `1:1` | `1024x1024` |
| `16:9` | `1344x768` |
| `4:3` | `1152x864` |
| `3:4` | `864x1152` |
| `9:16` | `768x1344` |

### Provider 优先级

AetherMesh 图像生成优先级高于 MiniMax。当 AetherMesh 配置存在时，`generate_image` 工具自动路由到 AetherMesh；若需回退到 MiniMax，移除 AetherMesh baseURL 即可。

## 图像识别

Bailongma 通过 `analyze_image` 工具让 LLM 理解图片内容。模型在对话中接收到图片时，可以自动调用分析工具获取图片描述，或由用户显式要求分析。

### 支持的途径

| 方式 | 说明 |
| --- | --- |
| **Gemma Vision（AetherMesh）** | 通过本地部署的 AetherMesh 调用 Gemma 3 Vision 等多模态模型，完全离线 |
| **渠道内置 Vision** | Telegram 收到的图片可自动送入 vision 模型分析 |

### 配置

在 Brain UI 设置页 → AI 面板中，配置图像识别模型的 Base URL 和 Key（复用 AetherMesh 配置即可，需 vision 模型如 `gemma-3-12b-it-vision`）。

### 在聊天中使用

用户发送含图片的消息（通过 Brain UI 粘贴/拖拽，或 Telegram 发送图片）时，LLM 可自动调用 `analyze_image` 工具理解图片。也可直接要求分析：

- 中文：`分析这张图片`、`图片里有什么`
- 英文：`what's in this image`、`analyze this picture`

## 语音系统

### ASR（语音识别）

| 服务商 | 字段 | 说明 |
| --- | --- | --- |
| 阿里云百炼 Paraformer（首选） | `aliyunApiKey` | 延迟低，中文效果出色 |
| 腾讯云 ASR | `tencentSecretId/Key/AppId` | 支持粤语、英语等多语种 |
| 科大讯飞 RTASR | `xunfeiAppId/ApiKey/ApiSecret` | 中文识别老牌服务 |
| 火山引擎 ASR | `volcAsrApiKey/AppKey/AccessKey/ResourceId` | 字节跳动云端 ASR |
| AetherMesh Whisper（本地） | `aethermeshBaseURL` + `aethermeshAsrModel` | 本地部署，完全私密，OpenAI `/v1/audio/transcriptions` 兼容格式 |

### TTS（语音合成）

| 服务商 | 字段 | 说明 |
| --- | --- | --- |
| 豆包语音合成 2.0（首选） | `doubaoKey` | 流式低延迟，中文音色丰富 |
| MiniMax | 复用 LLM 密钥 | 无需额外配置 |
| OpenAI | `openaiTtsKey` | 英文效果顶级 |
| ElevenLabs | `elevenLabsKey` | 超自然音色，有免费额度 |
| 火山引擎基础版 | `volcanoAppId` + `volcanoToken` | 传统版 TTS |
| 自定义 OpenAI 兼容 | `customTtsKey/ BaseURL/Model` | 兼容 OpenAI `/v1/audio/speech` 接口 |
| AetherMesh 语音克隆（本地） | `aethermeshBaseURL` | XTTS-v2 等本地模型，支持声音克隆 |

### 本地语音配置示例

使用 AetherMesh 连接本地 XTTS-v2 TTS 和 Whisper ASR：

```json
{
  "voice": {
    "voiceProvider": "aethermesh",
    "aethermeshBaseURL": "http://192.168.1.200:8001",
    "aethermeshKey": "your-api-key",
    "aethermeshAsrModel": "whisper-large-v3",
    "aethermeshLanguage": "zh-tw"
  },
  "tts": {
    "ttsProvider": "aethermesh",
    "aethermeshBaseURL": "http://192.168.1.200:8001",
    "aethermeshKey": "your-api-key",
    "aethermeshLanguage": "zh-tw",
    "ttsVoiceId": "your-registered-voice-uuid"
  }
}
```

> ⚠️ XTTS-v2 需要先通过 `POST /v1/voices` 注册/克隆声音，`ttsVoiceId` 应使用注册后返回的 UUID，而非模型名。

### 逐人语音偏好

在人物卡片中可以为每个角色指定独立的 TTS 语言和音色。当 Agent 对该角色说话时，会自动使用其对应的语言和音色进行合成。如果角色配了非其语言的文本，系统会自动翻译后再合成语音。

配置方式：在 Brain UI 的人物卡片面板中，选择 TTS 服务商（如 AetherMesh），填写该角色的声音 ID 和语言代码（如 `zh-tw`、`en`、`ja` 等）。

## 社交连接器

### Discord

通过 Discord Bot 接收和发送消息，支持多频道和多服务器。

### 微信

通过微信客户端桥接（Clawbot），扫码连接后自动收发消息。

### Telegram

通过 Telegram Bot API 长轮询方式接收消息，回复自动路由回对应聊天。

配置步骤：

1. 在 Telegram 中通过 [@BotFather](https://t.me/BotFather) 创建 Bot，获取 Token
2. 设置环境变量：

```text
TELEGRAM_BOT_TOKEN=<your-bot-token>
```

3. 启动 Bailongma 后自动开始轮询消息

特性：

- 长轮询模式，适配 NAT/家庭网络环境
- 自动重连（指数退避，2s → 60s）
- 消息进入主循环统一处理，回复按渠道路由返回 Telegram
- 支持 SSE 事件流推送社交状态变化

## 数据与持久化

Bailongma 的长期状态主要保存在本地 SQLite 数据库中，包括：

- 对话记录、参与者身份和用户画像。
- 记忆节点、记忆关系、全文检索索引和可见性状态。
- 行动日志、工具结果摘要和回合轨迹。
- 提醒、预取任务、预取缓存和 UI 信号。
- 媒体历史、音乐库和 AI 视频记录。
- 焦点线程、承诺状态和旧焦点栈迁移结果。
- 微信桥接凭证与各类本地配置。

`sandbox/` 用作 Agent 的工作区，适合放置生成文件、临时项目、下载内容和媒体产物。`data/` 是运行数据目录，打包时会被排除。

## 工具系统

工具 schema 按能力拆分在 `src/capabilities/schemas/` 下，运行时由 `src/capabilities/schemas.js` 汇总。主循环会根据当前消息、任务状态、最近行动日志、UI 信号和可用 Provider 能力选择本轮要暴露给模型的工具，避免每轮都注入完整工具集。

内置工具覆盖这些方向：

- 给用户或外部渠道发送消息。
- 读取、列目录、写入和删除文件。
- 执行 Shell 命令和管理长运行进程。
- 搜索网页、抓取网页、读取浏览器内容。
- 搜索、召回、写入、合并和降权记忆。
- 管理提醒和预取任务。
- 展示、更新和关闭 ACUI 卡片。
- 生成语音、控制媒体面板、管理音乐和生成视频。
- 委托本地 Agent 执行子任务。
- 复核已完成工作。

工具市场允许安装自定义工具。安装后的工具会持久化在沙箱相关目录中，并在后续回合按需加入可用工具列表。

## Brain UI

Brain UI 是项目的主要操作界面，前端位于 `src/ui/brain-ui/`。它负责展示：

- 多渠道聊天和实时思考流。
- 记忆图、焦点线程和当前任务状态。
- 热点信息、文档知识、人物卡片和系统提示预览。
- 语音面板、TTS 效果、微信二维码弹窗和设置页。
- ACUI 卡片，如天气、自检、唤醒、图片、视频和安全确认。

前端通过 HTTP、SSE 和 WebSocket 与后端通信。Electron 预加载脚本会额外提供桌面端能力，例如窗口缩放、更新状态和外链打开。

## 测试与维护脚本

常用脚本：

```bash
npm run smoke:tools
npm run smoke:brain-ui
npm run smoke:social
npm run test:rule-context
npm run test:complex-task
npm run test:relevance
npm run test:section-gate
npm run test:agent-skills
npm run test:config-upgrade
```

记忆修复和配置探测：

```bash
npm run repair:memories:dry
npm run repair:memories
npm run probe:config-upgrade
```

打包与构建：

```bash
# macOS（Intel Mac 建议指定 x64，避免双架构重构后原生模块架构不匹配）
npm run build:mac:x64      # 只构建 x64 DMG
npm run build:mac:arm64    # 只构建 arm64 DMG
npm run build:mac           # 同时构建 x64 + arm64 DMG

# Linux（需在 Linux 系统上执行，不支持交叉编译）
npm run build:linux          # 默认 x64，产出 AppImage + deb
npm run build:linux:x64
npm run build:linux:arm64

# Windows
npm run build:win            # 产出 NSIS 安装包

# 通用构建
npm run build                # 构建当前平台
```

> ⚠️ **Mac 架构注意：** `npm run build:mac` 会先重建 x64 的 better-sqlite3，再重建 arm64。**最后留在 node_modules 中的是 arm64 架构**，如果你在 Intel Mac 上继续用 `npm start` 开发，需要重新重建 x64：
> ```bash
> npx electron-rebuild -f -w better-sqlite3 -v 33.4.11 -a x64
> ```

> ⚠️ **Linux 构建注意：** electron-builder 不支持跨平台编译，Linux 包必须在 Linux 系统上构建。Ubuntu 需先安装依赖：
> ```bash
> sudo apt-get install -y libgtk-3-dev libxss1 libnss3 libasound2 libnotify-dev libxtst-dev libx11-xcb-dev libgl1-mesa-dev
> ```

发布到 GitHub Releases：

```bash
npm run publish
```

## 安全与访问控制

- 默认只允许本机访问本地服务。
- 敏感路径包括激活、设置、管理和记忆修改接口。
- 可以通过环境变量显式允许局域网访问。
- 可以通过 API Token 让远程请求携带凭证访问。
- 文件与工具能力经过执行器统一路由，部分危险操作会进入确认或策略流程。
- Electron 桌面端启用上下文隔离，前端通过预加载桥接访问必要能力。

## License

[MIT License](./LICENSE)

## Completed
- Telegram 連接器完整實作（後端+前端+派發路由）
- Telegram 排除 identity/channel 等 5 處缺失導致回復無法送達
- 自定義 OpenAI 相容 TTS Provider
- custom-openai 模型/聲音刷新按鈕
- AetherMesh TTS Provider（POST OpenAI 相容格式）
- 逐人語音偏好（人物卡片 preferredVoice 欄位）
- AetherMesh 設定 UI（API Key / Base URL / 聲音 ID）
- @all 語音克隆代理 + 人物卡片聲音設定
- AetherMesh ASR Provider（POST /v1/audio/transcriptions）
  - cloud-asr.js: createAetherMeshSession — 緩衝 PCM → flush 時包 WAV
  - config.js: aethermeshKey/aethermeshBaseURL → VOICE_CONFIG_KEYS
  - api.js: WS handler 合併 TTS 憑證供 AetherMesh ASR 使用
  - app-shell.js: 下拉選單 + 憑證面板
  - app.js: applyVoiceProviderUI + 儲存處理
  - doc.js: ASR 設定頁籤

## Confirmed Working
- AetherMesh 語音合成已通（POST /v1/audio/speech, xtts-v2 model）
- 語音克隆代理（POST /v1/voices）已接入
- AetherMesh ASR 完整鏈路已通（緩衝 PCM → WAV → POST /v1/audio/transcriptions）
  - 3 次修正：WS 路由邏輯（JSON 優先）、15s HTTP timeout、close() 等 pending flush
- 語音對話可按住空白鍵發話 + AetherMesh 轉錄 + Jarvis 回覆 + AetherMesh TTS
- 編譯後 EHOSTUNREACH 修復：
  - smart global fetch patch（src/aethermesh-fetch.js）：local IP → Electron net.fetch，外網 → 原生 fetch
  - aethermeshFetch 取代全部 AetherMesh API 呼叫中的 fetch（api.js / tts-providers.js）
  - duplex proxy 路由緩衝 body 後轉發（register / clone-voice）

## Pending
- AetherMesh ASR WebSocket（ws://192.168.1.200:8001）在編譯 app 中仍 EHOSTUNREACH（ws 庫走 libuv TCP，與 fetch 不同協議層）
- 解決方案：前端 voice-core.js 直接以 Chromium WebSocket 連 AetherMesh ASR，繞過 main process TCP 限制
  - 已實作：connectAethermeshAsr / createAethermeshAsrWs — 避免後端 ws 庫
  - 已實作：PCM 路由至前端 WS 而非後端 WS
  - 需驗證：完整語音循環（ASR → LLM → TTS）在編譯 app 中
- 人物卡片聲音試聽按鈕測試
- 逐人語音偏好 execSpeak 整合（target_person → preferredVoice）
- 語音克隆代理端對端驗證

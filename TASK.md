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
- Telegram 語音消息（轉錄 + TTS 語音回覆）
- TUI 語音輸入截斷修復（6s 靜音延遲/雙 WS flush）
- 截圖移除 + 圖片上傳取代 + 影片上傳 + 幀提取

## Confirmed Working
- AetherMesh 語音合成已通（POST /v1/audio/speech, xtts-v2 model）
- 語音克隆代理（POST /v1/voices）已接入
- AetherMesh ASR 完整鏈路已通（緩衝 PCM → WAV → POST /v1/audio/transcriptions）
- 語音對話可按住空白鍵發話 + AetherMesh 轉錄 + Jarvis 回覆 + AetherMesh TTS
- 編譯後 EHOSTUNREACH 修復（smart global fetch patch）
- 影片幀提取流程（ffmpeg 自動下載 + multipart 上傳 → frame extraction → data URL）
- multipart 解析修正（以 boundary 為基準避免二進位誤判）

## Pending
- AetherMesh ASR WebSocket（ws://192.168.1.200:8001）在編譯 app 中仍 EHOSTUNREACH
  - 解決方案：前端 voice-core.js 直接以 Chromium WebSocket 連 AetherMesh ASR，繞過 main process TCP 限制
  - 已實作：connectAethermeshAsr / createAethermeshAsrWs — 避免後端 ws 庫
  - 需驗證：完整語音循環（ASR → LLM → TTS）在編譯 app 中
- 人物卡片聲音試聽按鈕測試
- 逐人語音偏好 execSpeak 整合（target_person → preferredVoice）
- 語音克隆代理端對端驗證
- Vision 端到端驗證：上傳圖片 → AetherMesh VLM → 回應
- 影片幀提取已可運作（暫存檔 + spawn + 400px/quality 8 / 自適應幀數）
- 不再使用 pipe 或 execFile 處理二進位輸出

## Settings UI updates (2026-07-08)
- AI 設置 tab 新增文生圖模型輸入框（aethermeshImageModel）
- VLM 當前狀態改為顯示文生圖模型而非 LLM 模型
- 修復 loadSettings 讀取 tts.tts.aethermeshImageModel 路徑錯誤

## Bug: Telegram image analysis lost on follow-up (FIXED)
- `analyze_image` tool 只依賴當前 messageBody 中的 inline image pattern
- 用戶送圖後追問"你沒幫我分析照片"，第二輪消息體不含 data:image → tool 不在列表
- 修復：tool-router.js selectTools 同時掃描 conversationWindow 中各條 content

## Bug: LLM stream timeout on image messages (FIXED)
- 非視覺端點（雲端 LLM）收到包含 data:image 的消息時，base64 數據作為純文本塞入 context，導致 token 爆炸超時
- 修復：formatConversationMessage / buildLLMMessages 對非視覺端點自動將 `![...](data:...)` 替換為 `[image: ...]`

## Bug: callGemmaVision double /v1 in URL (FIXED)
- 用戶 config.baseURL = http://192.168.1.200:8001/v1（Custom Endpoint）
- 代碼硬拼 `${baseURL}/v1/chat/completions` → .../v1/v1/chat/completions → 404
- 修復：先 `.replace(/\/v1$/, '')` 再補 `/v1/chat/completions`
- 移除 image-gen tab 時遺留孤兒 HTML（save button + 3 orphaned `</div>`）在 AI tab 關閉之後
- 導致 media/social/voice/web-search/security/update 的 DOM 嵌套全部被破壞，內容溢出設定視窗
- 已刪除殘留標籤

## 2026-07-11: ONNX embedding crash when Telegram photo has data:image base64 URL (FIXED)
- Telegram photo 消息含 `![telegram photo](data:image/jpeg;base64,...)`，57313 chars base64 送進 onnxruntime 後因維度不符崩潰
- 修復：`computeEmbedding()` 在送進 ONNX 前 strip 掉 markdown data URL，所有路徑（recognizer、backfill）經由同一入口
- ✅ Windows 實測：影片、照片分析、生成照片全部正常運作

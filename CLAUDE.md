# CLAUDE.md — BaiLongma_ft 專案規範

> 本檔記錄 BaiLongma_ft fork 的工作規範與重要技術細節，補充全域 `~/.claude/CLAUDE.md`。

## Repository

- **Upstream**: `https://github.com/xiaoyuanda666-ship-it/BaiLongma.git`（branch `upstream/refactor/codebase`，不是 `main`——main 是舊版 v2.1.515）
- **Origin (fork)**: `https://github.com/fred-lede/BaiLongma_ft.git`
- **本地工作分支**: `main`（直接追蹤 `origin/main`；upstream 變更先 fast-forward 進來再處理）

## Build

Mac 簽章憑證均已失效（`CSSMERR_TP_CERT_REVOKED`），一定要用：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --config.mac.identity=""
```

`package.json` 已設 `forceCodeSigning: false`。

## Config 結構（上游 refactor 後）

- `config.js` 內部已改用 `readExistingStoredConfig()` / `writeStoredConfig()`——**不是** `getStoredConfig()` / `writeConfig()`。新增欄位時要加進對應 whitelist：
  - `TTS_CONFIG_KEYS`（如 `responseLanguage`、`aethermeshLanguage`、`aethermeshKey`、`aethermeshBaseURL`、`aethermeshImageModel`）
  - `VOICE_CONFIG_KEYS`（如 `lang`、`macosRecognitionMode`）
  - `SOCIAL_ENV_KEYS`（如 `TELEGRAM_BOT_TOKEN`）
- TTS voice 的持久化路徑：`voiceConfigDir/`（per-provider JSON），不再是 `config.json` 的 `voice` 區段。
- `VOICE_PROVIDERS` Set 與 `VOICE_PROVIDER_KEYS` map 是 provider 白名單，加新 provider 要一起更新。

## 重要 Details

### Response Language（回覆語言）

- 欄位：`tts.responseLanguage`，值 `auto|zh-cn|zh-tw|en|ja|ko|es`
- 注入點：`src/index.js:1014-1022`，注入到 `directions.unshift()`——在 direction 佇列最前面（最高優先）。
- **衝突已修（2026-07-28）**：原本每次 user turn 都會先注入「mirror the current message language」direction（line 978），跟 `responseLanguage !== 'auto'` 時的強制語言 direction 直接衝突。現在當 `responseLanguage !== 'auto'` 時**跳過** auto-mirror reminder，只保留明確語言 preference direction。
- **Slow-ack 本地化**：`src/llm.js:slowAckText()` 原本全中文硬編碼（"我查一下"、"在畫了"、"我跑一下"…），現在依 `responseLanguage` 取本地化文案（en/ja/ko/es 支援，未匹配回退中文）。`getTTSConfig` 需從 `config.js` import 進 `llm.js`。
- **TTS 發音**：`src/voice/tts-providers.js:495` AetherMesh 路徑 — `responseLanguage !== 'auto'` 時用它指定發音語言，否則 fallback `aethermeshLanguage`。
- **Test 按鈕**：`src/ui/brain-ui/app.js` 對應不同語言有專屬測試文案。

### Telegram 圖片生成

- **Direction 已還原（2026-07-28）**：上游 refactor 把這段 direction 移除了，導致 LLM 只回 `"图片已生成：\n/media/chat/abc.png"` 純文字（不包 markdown），`sendTelegramMessage` 的 markdown regex 命中不到 → 退走 `sendMessage` 純文字，手機收不到圖。現已在 `src/index.js:1024-1027` 加回 Telegram 專屬 direction：
  > "IMPORTANT — Telegram users cannot see local images. If the user asks you to generate an image, you MUST call the generate_image tool first and wait for its result. Do NOT send placeholder text like "在畫" or "Drawing". Once the image is generated, call send_message with the markdown image URL (e.g. ![image](/media/chat/<filename>)) embedded in the content field..."
- **後備機制**：`src/social/telegram.js:sendTelegramMessage()` 同時匹配 markdown `![alt](/media/chat/x)` 與裸路徑 `/media/chat/x`（LLM 偶爾沒包 markdown 時也能 catch 到）。
- **`/media/chat/<filename>` 檔名**：是 sha256 hash（內容尋址），由 `src/chat-media.js:persistChatMediaBuffer` 產生，不是時間戳。

### Telegram 訊息路由（為什麼 TUI 會顯示兩次）

- 外部訊息入站時 `src/social/telegram.js` 兩次觸發：
  1. `emitEvent('message_in', ...)` → TUI `app.js:2709` 把它當成 external 訊息（左側灰色泡泡，label 如 `telegram:8409351929`）。
  2. `pushMessage('ID:000001', ...)` → 入隊 L2 turn，TUI 再當成 user 訊息顯示一次（右側 `ID:000001`）。**這是正常設計**，不是 bug。

### Voice Channels

- `VOICE_CHANNELS` Set（`src/runtime/channel.js`）：`voice`, `VOICE`, `语音识别`, `语音对话`, `FocusBanner`。
- **TELEGRAM 和 TUI 不在 voice channels**——但有語音訊息時透過 `voiceReplyChats` Set + `voiceModes` Map 控制回覆是否走 TTS。
- TUI 語音 turn 結束的 `speak: true` 標記：`src/index.js:384` 的 `deliverFallbackReply` 只在 `isVoiceChannel(channel)` 時設。

## 禁制事項

- **不 commit 未驗證的修改**——must 先 `node --check <file>` 或視情況 `npm run <test-script>`。
- **不新增 emoji 到 commit message 或文件**，除非 user 明確要求。
- ** 不更新全域 `~/.claude/CLAUDE.md`**（那是個人規範，不寫專案狀態）。本檔路徑：`<repo>/CLAUDE.md`。
- **沒有 lint/typecheck script**——`package.json` 只有各種 `test:*` 和 `smoke:*`。語法檢查用 `node --check <file>` 作替代。

## 工作流偏好

- 修 bug 前先讀 fork 版 git history 找類似 commit（`git log --all --oneline --grep="..."`）；fork 已經解過的問題很可能上游 refactor 又把它拿掉。
- 修完後 user 會手動 rebuild + 測試；不要主動建議 commit 直到 user 確認能動。
- 用者偏好繁體中文回覆，但代碼/commit message/technical terms 用英文。

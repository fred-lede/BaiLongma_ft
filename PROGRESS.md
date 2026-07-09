# Progress Log

## 2026-07-09

### Fixed
- **Image gen model input not saving** (`src/ui/brain-ui/app.js`): `loadSettings()` was reading `ttsCfg.tts.aethermeshImageModel` but the save handler wrote to `ttsCfg.aethermeshImageModel`. Fixed the save path to use `ttsCfg.tts` consistently.
- **VLM status showing wrong model**: Status indicator was reading the LLM model name instead of the image gen model.
- **Telegram image analysis lost on follow-up**: `analyze_image` result contained only `message_id` without `imageMessageId`, causing conversation window scan to miss it. Added `imageMessageId` persistence.
- **LLM stream timeout for image messages**: Non-vision LLM endpoints received base64 data URLs in user messages, causing long stalls. Added `stripImageDataUrls()` for non-vision endpoints.
- **Vision API 404 (`callGemmaVision`)**: Config `baseURL` (e.g., `http://host:8001/v1`) combined with endpoint path `/v1/chat/completions` produced `http://host:8001/v1/v1/chat/completions`. Added trailing `/v1` strip.
- **Orphaned HTML in settings modal**: Unclosed `<div id="activate-prompt-wrapper">` broke all tabs after the AI tab. Removed hanging markup.
- **Voice tab credential fields show as empty**: Backend returns `{ configured: bool }` for credential fields but frontend never checked this. Added `setCredentialIndicator()` to show "已配置，留空则不修改" with green border on load.
- **AetherMesh ASR fields also not showing indicator**: Added `setCredentialIndicator` for AetherMesh key/base URL.

## 2026-07-10

### Added
- **Telegram voice message support**: `msg.voice` handler downloads OGG audio, transcribes via AetherMesh Whisper (`POST /v1/audio/transcriptions`), uses transcribed text as message content. Falls back to `[语音消息 Ns]` placeholder if ASR fails.
- **Telegram voice reply**: When incoming message is voice, bot replies with TTS-synthesized audio via `sendVoice` API. Long text is chunked (≤100 chars per TTS call) and MP3 buffers concatenated to avoid server truncation. Caption includes full text (up to 1024 chars).
- **`/voice auto|on|off` command**: Per-chat voice reply mode control via Telegram. `auto` follows input type, `on` forces voice, `off` forces text.
- **Persistent voice flag**: Voice reply flag persists across all bot replies until user sends a text message (not just first reply).

### Fixed
- **ASR multipart body parsing**: `form-data` stream incompatible with Node.js `fetch` — switched to `multipartRequest` (native `http`/`https.request`) with proper auth headers.
- **AetherMesh TTS timeout**: Hardcoded 15s timeout in `streamAetherMesh` → dynamic `max(30000, text.length * 80)` ms.
- **TUI voice input truncation**: `flushAsr()` now sends to both `aethermeshAsrWs` and `cloudWs`. Auto-send now flushes ASR + waits 400ms for final transcript. When final result doesn't end with sentence terminator (。！？\n), silence delay doubles to 6s to avoid VAD mid-sentence cutoff.
- **Screenshot button "截屏失败"**: (1) added `display-capture` to permission handlers in `electron/main.cjs:458`, (2) `screenshot:capture` IPC handler tries `desktopCapturer.getSources()` → clipboard → clean error, (3) chat.js no longer `throw` on IPC failure so clipboard/`getDisplayMedia` fallbacks actually execute.

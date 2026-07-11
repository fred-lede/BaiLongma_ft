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
- **Screenshot button changed to image/video upload**: Replaced entire screenshot flow (getDisplayMedia/desktopCapturer/clipboard) with a hidden `<input type="file" accept="image/*,video/*">`. Video files uploaded to server, frames extracted via FFmpeg, inserted as pasted images with context prefix in input area.

## 2026-07-11

### Added
- **Video frame extraction module** (`src/media/video-frame.js`): FFmpeg detection (which/where), auto-download from ffmpeg-static GitHub releases, duration probe with `ffmpeg -i`, adaptive frame sampling (3/5/8/10 based on duration), JPEG binary splitting via SOI/EOI markers.
- **Video analysis API endpoint** (`POST /media/video/analyze`): Accepts multipart video upload, extracts frames, returns `{ok, frames: [{dataUrl, timestamp}], durationSec}`.
- **Telegram video handler**: `msg.video`/`msg.video_note`/video documents → download → frame extraction → markdown image context in chat.
- **TUI video upload flow**: Video files selected via upload button → POST to `/media/video/analyze` → frames converted to File objects → `addPastedImageFiles()` + context text inserted into input area.

### Fixed
- **video-frame.js line 123 bug**: `'-i', tmp` used null when input was path (not Buffer) → changed to `'-i', inputPath`.
- **Multipart boundary parsing**: Naive `body.indexOf('\r\n\r\n')` could match binary data → rewritten to search from `afterFirstBoundary` to avoid false positives.
- **Screenshot button icon restoration**: Added `dataset.origIcon` save on init to ensure button text correctly restored after video processing.

### Fixed (2026-07-11 second pass)
- **Video frame extraction always returned 0 frames** (multiple issues):
  1. `execFile` returns stdout as string by default, binary JPEG corrupted when treated as UTF-8 → `splitJPEG` returns `[]`
  2. `-f image2pipe -` with MP4 input fails because moov atom at end of file requires seek (impossible with pipe)
  3. `execFile` throws on ffmpeg non-zero exit, but diagnosis code (`ffStderr.slice`) itself crashed → hid the real error
  4. **Real root cause**: ffmpeg exited with non-zero. Switched to `spawn` with proper stderr capture and temp files (same pattern as working terminal command).
- **ffmpeg not found in Electron** (PATH missing Homebrew dirs on macOS): Added fallback for `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`.
- **LLM timeout on 8 high-quality frames**: 800×800 JPEG at `-qscale:v 2` produced ~150KB/frame → 1.2MB total base64 → LLM 120s timeout. Reduced to 400×400, quality 8, and fewer frames (max 4 for 42s video).
- **Telegram visual feedback**: Added `sendChatAction('upload_video')` during video download/extraction, and `sendChatAction('typing')` before pushing to LLM. Users see "sending video..." then "typing..." indicator on Telegram.
- **TUI thinking indicator**: Added pulsing dot in chat header when Jarvis is processing (`#chat-history.jarvis-thinking::after`). Implemented `setPendingJarvis()` helper to consistently manage pending state + CSS class toggling.

## 2026-07-11 (third pass)

### Fixed
- **Tool name concatenation in stream**: When LLM streams `tool_calls` without `index`, `tc.index ?? 0` caused all tools to use slot 0, concatenating names and args. Changed to `toolCallCounter++` auto-increment for missing indices. Dedup guard added to prevent name accumulation.
- **Concatenated tool names persist in action log**: `getRecentActionLogs` reads from persistent SQLite, bad names like `analyze_imageanalyze_image` survived restart and kept re-injecting via ActionLog keep-alive. Added to `suppressed` set in `tool-router.js`, plus `VALID_TOOL_RE` regex filter on all action log / installed tool entries.
- **`findImageReference` ignores non-existent `image_path`**: When LLM passes a made-up `image_path`, it previously short-circuited and never scanned the conversation window for markdown data URLs. Now resolves the path first and only uses it if the file exists; otherwise falls through to markdown scan.
- **`analyze_image` frame cleanup**: Video frame files (`vf-*.jpg`) saved to media dir are now deleted automatically after `analyze_image` successfully reads them, preventing accumulation.

### Changed
- **Video frame quality improved**: `scale=400:-2` → `scale=720:-2`, `-qscale:v 8` → `2`. Frames now saved to `paths.mediaDir` instead of embedded as data URLs (`saveDir` option in `extractVideoFrames`). Telegram uses file paths (`/media/chat/vf-*.jpg`) instead of inline base64, saving ~100KB per frame in conversation window.

## 2026-07-11

### Fixed
- **ONNX embedding crash on Telegram photo**: `computeEmbedding()` received raw message containing `![telegram photo](data:image/jpeg;base64,...)` (57313 chars), which crashed onnxruntime's Add node with dimension mismatch (512 by 57313). Added `MD_DATA_URL_RE` regex to strip base64 data URLs before passing text to ONNX, covering all call paths (recognizer, embedding-backfill).

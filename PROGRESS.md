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

### Known
- Model sometimes concatenates tool names (`send_messagegenerate_image`) — auto-ack mechanism handles progress notes for slow tools; prompt should not instruct the model to manually call `send_message`.

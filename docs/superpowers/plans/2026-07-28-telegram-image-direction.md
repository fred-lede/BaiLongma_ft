# Telegram Image Generation Direction — Restore Plan & Fix Log

> **Date:** 2026-07-28 (commit `ca8f216`)
> **Status:** Implemented & verified working

---

## Symptom

User reports: 設定 `responseLanguage: "en"` 後用 Telegram 語音 `"請畫一張古裝美女"`，電腦 TUI 能看到生成圖片，但手機 Telegram **完全收不到照片**，只收到 `"图片已生成（1 张）：\n/media/chat/abc.png"` 純文字。

## Root cause investigation

### Step 1 — Inspect fork history first (per CLAUDE.md workflow)

```bash
git log --all --oneline --grep="photo\|telegram\|image" -20
```

Found two relevant commits:
- `8a8968e feat: Telegram image upload + vision analysis + TUI lightbox`
- `65f15fb feat: Telegram image generation support + AetherMesh image provider + runtime delivery`

### Step 2 — Diff old `sendTelegramMessage`

Old `65f15fb` fork's `sendTelegramMessage`:
```javascript
const imgMatch = String(content || '').match(/!\[.*?\]\(\/media\/chat\/([^)\s]+)\)/)
if (imgMatch) { /* sendPhoto */ }
```

This is identical to current upstream code — the matching logic wasn't changed.

### Step 3 — Look for what made the LLM emit markdown

Searched old `8a8968e` diff for `Telegram direction` and found:

```javascript
// src/index.js, added in fork 8a8968e
if (msg?.channel === 'TELEGRAM') {
  directions.push('IMPORTANT — Telegram users cannot see local images. If the user asks you to generate an image, you MUST call the generate_image tool first and wait for the result. Do NOT send placeholder text like "在畫了". After the image is generated, call send_message with the markdown image URL in the content field so the Telegram bot can upload and send the photo to the user.')
}
```

This direction **explicitly tells the LLM to use markdown image syntax** `![image](/media/chat/<filename>)` in `send_message`. Upstream refactor removed it. Without this direction, the LLM defaulted to the `generate_image` tool's raw return text:

```
图片已生成（1 张）：
/media/chat/abc.png
```

This is a **bare text path**, not markdown — so `sendTelegramMessage`'s markdown regex didn't match, and the bot fell back to `sendMessage` (which sends text only, photo never reaches the user).

## Fix

### 1. Restore the Telegram direction in `src/index.js`

Added back at line 1024-1027 (after the response-language direction injection):

```javascript
if (msg?.channel === 'TELEGRAM') {
  directions.push('IMPORTANT — Telegram users cannot see local images. If the user asks you to generate an image, you MUST call the generate_image tool first and wait for its result. Do NOT send placeholder text like "在畫" or "Drawing". Once the image is generated, call send_message with the markdown image URL (e.g. ![image](/media/chat/<filename>)) embedded in the content field. The system will extract that URL and upload the photo to the chat. Bare text URLs without markdown image syntax will NOT be sent as photos.')
}
```

Improvements over the original fork:
- Removed Chinese-only example ("在畫了") → added both 中/英 ("在畫" / "Drawing") as placeholders to skip
- Explicitly warns that bare text URLs will NOT be sent as photos
- Stays consistent with current `responseLanguage: "en"` setting (model reads both directions fine)

### 2. Add bare-path fallback in `sendTelegramMessage` (`src/social/telegram.js`)

Even with the restored direction, the LLM might occasionally forget to wrap the path in markdown. Added a secondary regex to catch bare `/media/chat/<filename>` paths:

```javascript
const bareMatch = !imgMatch
  ? stripped.match(/(^|\s)\/media\/chat\/([^\s)]+?)(?=[\s)\u3000]|$)/)
  : null
const filename = imgMatch ? imgMatch[1] : (bareMatch ? bareMatch[2] : null)
```

If markdown match fails, bare path match picks up the filename. Caption strips whichever form matched.

## Why this is a recurring upstream regression

Upstream's `src/index.js` refactor consolidated the directions injection block (lines 976-1027 now), and the Telegram-specific direction (which lived outside the searchable markers like `isVoiceChannel`) was simply **left out of the migration**. CLAUDE.md now records this as an "important detail" so the same drift won't need a re-investigation next time upstream merges.

## Verification (2026-07-28)

- Telegram voice `"請畫一張古裝美女"` with `responseLanguage: "en"` →
  - TUI shows generated image (markdown rendered locally). Expected.
  - **Telegram on phone receives the actual photo**. ✅ Fixed.
  - Optional English ack if `responseLanguage: "en"`: `"Drawing, just a sec~"` (from slowAckText localization in the same `ca8f216` commit).

## Files touched

- `src/index.js` — added back Telegram channel direction
- `src/social/telegram.js` — added bare-path fallback in `sendTelegramMessage`

## Related files (already in place, no change needed)

- `src/runtime/delivery.js` — `deliverMessage` builds outbound content with optional media marker
- `src/chat-media.js` — `persistChatMediaBuffer` returns `{ url: '/media/chat/<sha256>.<ext>', path, ... }`
- `src/providers/aethermesh-image.js` — returns `{ urls: ['/media/chat/<hash>.png'] }`
- `src/capabilities/tools/media/generation.js` — `execGenerateImage` returns `"图片已生成（N 张）：\n${urls.join('\n')}"` (text with bare paths)

# Response Language Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plants to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to select a response language (auto/zh-cn/zh-tw/en/ja/ko/es) so the AI replies in the chosen language regardless of input language.

**Architecture:** Replace the dead `aethermeshTranslate` checkbox with a `responseLanguage` dropdown. When not "auto", inject a language direction into the AI prompt. Pass the language to AetherMesh TTS for correct pronunciation.

**Tech Stack:** Electron, vanilla JS, AetherMesh TTS API

**Status:** Implemented & verified working (as of 2026-07-28, commits `9757029`, `a3c4b64`, `ca8f216`).

---

## Follow-up: Conflict Resolution & Localized Slow-ack (2026-07-28)

### Issue 1 — Language direction conflicted with auto-mirror reminder
- `src/index.js:978` injected `"mirror the current message language"` direction on **every** user turn.
- `src/index.js:1015` injected the explicit `Response language preference: ... MUST reply in ${langName}` direction when `responseLanguage !== 'auto'`.
- Both ended up in `directions.unshift()`. Even though the preference was at queue front (highest priority), two opposing instructions confused the model — often it kept mirroring the user's language (Chinese voice → Chinese reply instead of configured English).
- **Fix**: Skip the auto-mirror Language reminder when `responseLanguage !== 'auto'` (`src/index.js:980`).

### Issue 2 — Hardcoded Chinese slow-ack bypassed LLM
- `src/llm.js:slowAckText()` returned fixed Chinese strings like `"我查一下「${q}」～"`, `"在画了，稍等一下～"`, `"我跑一下～"`.
- These ack strings are emitted via `onToolCall('send_message', { __ack: true }, ...)` and spoken aloud by TTS even when `responseLanguage: "en"` was set — so the user heard `"我查一下..."` in Chinese before the final English reply.
- **Fix**: `slowAckText` now reads `getTTSConfig().responseLanguage` and returns localized strings for `en`, `ja`, `ko`, `es`; falls back to Chinese for `auto`/`zh-cn`/`zh-tw` or unmapped languages. Added `getTTSConfig` import to `src/llm.js`.

### Debug logs
- `src/index.js:1019,1021`: `console.log('[response-language] Injected direction for ${responseLanguage} (${langName}); ...')` — runtime verification of which branch fired.

### Verification (2026-07-28)
- `responseLanguage: "en"` + Chinese voice `"请告诉我台湾桃园的天气"` →
  - First ack: `"Let me look up "Taoyuan"~"` (English, correct pronunciation)
  - Final reply: `"Taoyuan is currently 34°C with patchy rain nearby."` (English)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/ui/brain-ui/app-shell.js:790-795` | Replace translate checkbox with language dropdown |
| `src/config.js:1876,1903,1933,1944` | Replace `aethermeshTranslate` with `responseLanguage` in TTS_CONFIG_KEYS and getters/setters |
| `src/ui/brain-ui/app.js:4254-4258,4301-4304` | Load/save the new dropdown value |
| `src/api/routes/tts.js:29-45` | Pass `responseLanguage` to streamTTS keys |
| `src/voice/tts-providers.js:473,495` | Accept and use `responseLanguage` for AetherMesh TTS |
| `index.js:978,1002-1008` | Inject response language direction into AI prompt |

---

### Task 1: Update Config Layer

**Files:**
- Modify: `src/config.js:1876,1903,1933,1944-1946`

- [ ] **Step 1: Replace `aethermeshTranslate` with `responseLanguage` in TTS_CONFIG_KEYS**

```javascript
// Line 1876: Change
'aethermeshKey', 'aethermeshBaseURL', 'aethermeshLanguage', 'aethermeshTranslate', 'aethermeshImageModel',
// To
'aethermeshKey', 'aethermeshBaseURL', 'aethermeshLanguage', 'responseLanguage', 'aethermeshImageModel',
```

- [ ] **Step 2: Update getTTSConfig() return value**

```javascript
// Line 1903: Change
aethermeshTranslate: !!stored.aethermeshTranslate,
// To
responseLanguage: stored.responseLanguage || 'auto',
```

- [ ] **Step 3: Update getTTSCredentials() return value**

```javascript
// Line 1933: Change
aethermeshTranslate: !!stored.aethermeshTranslate,
// To
responseLanguage: stored.responseLanguage || 'auto',
```

- [ ] **Step 4: Update setTTSConfig() handler**

```javascript
// Lines 1944-1946: Change
if (key === 'aethermeshTranslate') {
  next[key] = !!val
  continue
}
// To
if (key === 'responseLanguage') {
  next[key] = ['auto', 'zh-cn', 'zh-tw', 'en', 'ja', 'ko', 'es'].includes(val) ? val : 'auto'
  continue
}
```

- [ ] **Step 5: Commit**

```bash
git add src/config.js
git commit -m "feat: replace aethermeshTranslate with responseLanguage in config"
```

---

### Task 2: Update UI (app-shell.js)

**Files:**
- Modify: `src/ui/brain-ui/app-shell.js:790-795`

- [ ] **Step 1: Replace translate checkbox with language dropdown**

```javascript
// Lines 790-795: Change
<div class="settings-row">
  <label class="settings-label" for="tts-aethermesh-translate">实时翻译</label>
  <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--ink2);">
    <input type="checkbox" id="tts-aethermesh-translate" />
    语音对话时自动翻译为目标语言
  </label>
</div>
// To
<div class="settings-row">
  <label class="settings-label" for="tts-response-language">回复语言</label>
  <select class="settings-input" id="tts-response-language">
    <option value="auto">自动（跟随输入语言）</option>
    <option value="zh-cn">中文（简体）</option>
    <option value="zh-tw">中文（繁体）</option>
    <option value="en">English</option>
    <option value="ja">日本語</option>
    <option value="ko">한국어</option>
    <option value="es">Español</option>
  </select>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/brain-ui/app-shell.js
git commit -m "feat: replace translate checkbox with response language dropdown"
```

---

### Task 3: Update Frontend Load/Save (app.js)

**Files:**
- Modify: `src/ui/brain-ui/app.js:4254-4258,4301-4304`

- [ ] **Step 1: Update load handler**

```javascript
// Lines 4254-4258: Change
const aethermeshTranslateEl = document.getElementById("tts-aethermesh-translate");
// ...
if (aethermeshTranslateEl) aethermeshTranslateEl.checked = !!tts?.aethermeshTranslate;
// To
const responseLanguageEl = document.getElementById("tts-response-language");
// ...
if (responseLanguageEl && tts?.responseLanguage) responseLanguageEl.value = tts.responseLanguage;
```

- [ ] **Step 2: Update save handler**

```javascript
// Lines 4301-4304: Change
const aethermeshTranslate = document.getElementById("tts-aethermesh-translate")?.checked;
if (aethermeshTranslate !== undefined) ttsBody.aethermeshTranslate = aethermeshTranslate;
// To
const responseLanguage = document.getElementById("tts-response-language")?.value;
if (responseLanguage) ttsBody.responseLanguage = responseLanguage;
```

- [ ] **Step 3: Commit**

```bash
git add src/ui/brain-ui/app.js
git commit -m "feat: wire up response language dropdown load/save"
```

---

### Task 4: Pass Response Language to TTS (tts.js)

**Files:**
- Modify: `src/api/routes/tts.js:29-45`

- [ ] **Step 1: Add responseLanguage to keys object**

```javascript
// After line 44 (aethermeshLanguage), add
responseLanguage: creds.responseLanguage,
```

- [ ] **Step 2: Commit**

```bash
git add src/api/routes/tts.js
git commit -m "feat: pass responseLanguage to TTS stream"
```

---

### Task 5: Use Response Language in TTS Provider (tts-providers.js)

**Files:**
- Modify: `src/voice/tts-providers.js:473,494-496`

- [ ] **Step 1: Update streamTTS signature to accept responseLanguage**

```javascript
// Line 473: Change
export async function streamTTS({ text, provider, voiceId, keys = {}, language }) {
// To
export async function streamTTS({ text, provider, voiceId, keys = {}, language, responseLanguage }) {
```

- [ ] **Step 2: Use responseLanguage for AetherMesh TTS**

```javascript
// Lines 494-496: Change
case 'aethermesh': {
  const { stream } = await streamAetherMesh({ text, voiceId, baseURL: keys.aethermeshBaseURL, apiKey: keys.aethermeshKey, language: language || keys.aethermeshLanguage })
  return stream
}
// To
case 'aethermesh': {
  const ttsLang = (responseLanguage && responseLanguage !== 'auto') ? responseLanguage : (language || keys.aethermeshLanguage)
  const { stream } = await streamAetherMesh({ text, voiceId, baseURL: keys.aethermeshBaseURL, apiKey: keys.aethermeshKey, language: ttsLang })
  return stream
}
```

- [ ] **Step 3: Commit**

```bash
git add src/voice/tts-providers.js
git commit -m "feat: use responseLanguage for AetherMesh TTS language"
```

---

### Task 6: Inject Response Language into AI Prompt (index.js)

**Files:**
- Modify: `index.js:2,978,1002-1008`

- [ ] **Step 1: Import getTTSConfig**

```javascript
// Line 2: Change
import { config, getMinimaxKey as _getMinimaxKey, getSecurity, getTTSCredentials } from './config.js'
// To
import { config, getMinimaxKey as _getMinimaxKey, getSecurity, getTTSCredentials, getTTSConfig } from './config.js'
```

- [ ] **Step 2: Read responseLanguage and inject direction**

```javascript
// After line 978 (the language reminder), add response language override
const ttsConfig = getTTSConfig()
const responseLanguage = ttsConfig.responseLanguage || 'auto'
if (isVoiceChannel && responseLanguage !== 'auto') {
  const langNames = { 'zh-cn': 'Chinese (Simplified)', 'zh-tw': 'Chinese (Traditional)', 'en': 'English', 'ja': 'Japanese', 'ko': 'Korean', 'es': 'Spanish' }
  const langName = langNames[responseLanguage] || responseLanguage
  directions.unshift(`Response language preference: The user has set their preferred response language to ${langName}. You MUST reply in ${langName}, regardless of the language the user spoke. The system will handle pronunciation automatically.`)
}
```

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: inject response language direction into AI prompt"
```

---

### Task 7: Build and Test

- [ ] **Step 1: Build the app**

```bash
cd /Users/fred/ai/my_opencode/BaiLongma_ft
rm -rf dist
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --config.mac.identity=""
```

- [ ] **Step 2: Test scenarios**

1. Set "回复语言" to "English", speak Chinese → AI should respond in English, TTS speaks English
2. Set "回复语言" to "自动", speak Chinese → AI should respond in Chinese (mirror language)
3. Set "回复语言" to "中文（简体）", speak English → AI should respond in Chinese
4. Restart app → verify setting persists

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete response language selector feature"
```

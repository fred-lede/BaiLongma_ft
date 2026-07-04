# EHOSTUNREACH 修復摘要

## 問題
macOS 未簽署的 Electron 應用程式中，主進程（Node.js）的 libuv TCP 無法連接到本地子網（192.168.1.x），出現 `connect EHOSTUNREACH`。渲染進程（Chromium）不受影響。

## 受影響的元件

| 元件 | 協議 | 狀態 |
|------|------|------|
| AetherMesh LLM（providers/base.js fetch） | HTTP (undici/fetch) | ✅ 已修復（smart global fetch patch） |
| AetherMesh TTS（POST /v1/audio/speech） | HTTP (undici/fetch) | ✅ 已修復（aethermeshFetch） |
| AetherMesh API（voices/register/clone/health） | HTTP (undici/fetch) | ✅ 已修復（aethermeshFetch + body 緩衝） |
| AetherMesh ASR WebSocket（ws://.../stream） | WS (ws library via libuv) | ✅ 已修復（前端 Chromium WS 直連） |

## 修復方案

### 1. HTTP fetch 修復（`src/aethermesh-fetch.js`）
- Top-level await + `globalThis.fetch` 補丁
- `LOCAL_IP_RE` 正則：比對 localhost、192.168.x.x、10.x.x.x、172.16-31.x.x
- 本地 IP → `net.fetch`（Electron Chromium 網路棧）
- 外部 IP → 原始 Node.js `fetch`
- `src/api.js` + `src/voice/tts-providers.js`：所有 AetherMesh 呼叫改用 `aethermeshFetch`

### 2. duplex proxy 修復（`src/api.js`）
- `register`、`clone-voice` 路由：在呼叫 `aethermeshFetch` 前先緩衝整個 request body
- 解決 `net.fetch` 不接受 Node.js IncomingMessage 當作 body 的問題

### 3. ASR WebSocket 修復（`src/ui/brain-ui/voice-core.js`）
- `createAethermeshAsrWs()`：工廠函式，建立 Chromium `new WebSocket()` 直連 AetherMesh
- `connectAethermeshAsr()`：設定事件處理常式，路由 transcript → `handleAsrMessage`
- `connectCloudWs()`：provider === 'aethermesh' 時跳過後端 WS，改啟動 `connectAethermeshAsr`
- `handlePcmChunk()`：PCM 優先發往 `aethermeshAsrWs`
- `stopCloudStream()`：同時關閉 `aethermeshAsrWs`
- `resumeSession()`：AetherMesh 模式重連前端 WS 而非後端 WS

## 未來的 EHOSTUNREACH 修復
任何新的 main process TCP 連接到本地子網都需要以下之一：
- 透過 `net.fetch`（HTTP 類）
- 透過 renderer `new WebSocket()`（WS 類）
- （或取得有效的 Apple 程式碼簽署憑證）

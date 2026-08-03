# ComfyUI Image Provider Design

> Date: 2026-08-02
> Status: Draft

## Goal

Add ComfyUI as a selectable image generation engine alongside the existing
AetherMesh and MiniMax providers. The user runs ComfyUI on a separate Windows
PC (RTX 4070 Ti Super 16G, device 1), reachable over the LAN from the Mac
running BaiLongma. The ComfyUI engine is pinned to GPU 1; GPU 0 (RTX 5090)
stays dedicated to the AetherMesh server.

## Requirements

- Settings UI gets an explicit "生圖引擎" (image engine) dropdown: ComfyUI /
  AetherMesh / MiniMax / auto.
- Switching engines uses the same existing `generate_image` tool. The LLM does
  not know which backend is used.
- ComfyUI connection is configurable via base URL (works for localhost and
  remote). Default `http://122.116.209.1:8188`.
- ComfyUI workflow support:
  - Built-in generic text-to-image template using `CheckpointLoaderSimple`
    (checkpoint filename from settings), with aspect-ratio → latent size
    conversion.
  - Optional custom workflow JSON: a `PROMPT`-titled `CLIPTextEncode` node is
    filled with the generated prompt; all other nodes are left untouched.
- Remote access token support (ComfyUI `--api-auth`).
- GPU pinning is a ComfyUI launch-time concern, not a BaiLongma setting. The
  launch command is documented here.

## Current Architecture (unchanged parts)

- `execGenerateImage()` in `src/capabilities/tools/media/generation.js` calls
  `callCapability('image', { prompt, aspect_ratio, n })`.
- `src/providers/registry.js` `getProvider(capability)` returns the first
  provider whose `canDo(capability)` is true, in registration order.
- AetherMesh registers before MiniMax, so AetherMesh wins today.
- AetherMesh image provider uses OpenAI-style `/v1/images/generations`.
- Providers persist generated images via `persistChatMediaBuffer()` in
  `src/chat-media.js`, which returns `/media/chat/<sha256>.<ext>` URLs.

## Design

### 1. Provider — `src/providers/comfyui-image.js`

`ComfyUIImageProvider extends BaseProvider`:

- `canDo('image')` → true.
- `call('image', params)` → `#image({ prompt, aspect_ratio, n })`.

#### Workflow resolution

1. If `comfyuiWorkflowPath` is set and readable:
   - Load the JSON (ComfyUI "API format" — node graph keyed by node id).
   - Find the `CLIPTextEncode` node whose title contains `PROMPT` (case
     insensitive). Fill its `inputs.text` with the prompt.
   - Error if no such node exists, or the JSON is invalid.
2. Otherwise use the built-in template:

```
CheckpointLoaderSimple ──> CLIPTextEncode(positive, text=prompt) ─┐
CheckpointLoaderSimple ──> CLIPTextEncode(negative, text="")     ─┤
EmptyLatentImage(w,h by aspect_ratio) ────────────────────────────┤
                                                                  ▼
                                                        KSampler ─> VAEDecode ─> SaveImage
```

- Checkpoint filename from `comfyuiCheckpoint`.
- Negative prompt: empty string.
- Latent size conversion (SDXL-style multiples of 64):

| aspect_ratio | width | height |
|--------------|-------|--------|
| `1:1`  | 1024 | 1024 |
| `16:9` | 1344 | 768  |
| `4:3`  | 1152 | 864  |
| `3:4`  | 864  | 1152 |
| `9:16` | 768  | 1344 |

- Seed: fixed `random()` seed so each call varies; steps 28; cfg 7.0; sampler
  `euler`; scheduler `normal`; denoise 1.0.

#### HTTP flow (ComfyUI REST API)

1. `POST {baseURL}/prompt`
   - Headers: `Content-Type: application/json`. If `comfyuiToken` is set, send
     `Authorization: Bearer <token>`. (ComfyUI's exact auth scheme varies by
     version; if `--api-auth user:pass` is used, the header may instead need to
     be `Authorization: Basic base64(user:pass)`. Verify during implementation
     and match the running ComfyUI version.)
   - Body: `{ prompt: <api-format workflow>, client_id: <uuid> }`.
   - Response: `{ prompt_id }`.
2. Poll `GET {baseURL}/history/{prompt_id}` every 1s, up to 120s.
   - Response shape: `{ "<prompt_id>": { outputs: { "<node_id>": { images:
     [{ filename, subfolder, type }] } } } }`.
   - A non-empty `outputs.images` array means the job finished.
3. For each output image:
   - `GET {baseURL}/view?filename=<filename>&subfolder=<subfolder>&type=<type>`
   - Write bytes to `persistChatMediaBuffer(buffer, { ext, mime })`.
4. Return `{ urls }` (possibly multiple images).

#### Errors

- Connection refused / fetch network error → `ComfyUI 无法连接 (<baseURL>)`.
- `POST /prompt` non-200 → include ComfyUI's JSON error message.
- Poll timeout → `ComfyUI 生成超时（120 秒）`.
- Custom workflow without a `PROMPT`-titled node → explicit error.

### 2. Config — `src/config.js`

Add to `DEFAULT_CONFIG` and the relevant whitelist (`TTS_CONFIG_KEYS`, mirroring
`aethermeshImageModel`'s handling):

- `imageEngine: ''` — `''` = auto (registration order), `'comfyui'`,
  `'aethermesh'`, `'minimax'`.
- `comfyuiBaseURL: 'http://122.116.209.1:8188'`
- `comfyuiCheckpoint: ''`
- `comfyuiWorkflowPath: ''`
- `comfyuiToken: ''` — optional; used as `Authorization: Bearer`.

Expose getters/setters via `getTTSConfig` / `saveLLMSettings` so the settings
API can read/write them (matching how `aethermeshImageModel` flows).

### 3. Provider registry — `src/providers/registry.js`

- Extend `getProvider(capability, engine = '')`:
  - If `engine` is a non-empty value, prefer a provider whose `name`
    startsWith(engine) and whose `canDo(capability)` is true. This matches the
    registered names `comfyui-image`, `aethermesh-image`, `minimax` against the
    config values `comfyui`, `aethermesh`, `minimax`.
  - Otherwise fall back to first-match by registration order.
- Register `ComfyUIImageProvider` in `src/index.js` (near
  `registerAetherMeshImageIfAvailable`), always available (no key required).

### 4. Settings UI — `src/ui/brain-ui/app-shell.js` + `app.js`

- Replace the fixed "文生圖模型" input row with an "生圖引擎" select:
  options 自動 / ComfyUI / AetherMesh / MiniMax.
- Show a ComfyUI section (conditionally, when ComfyUI or auto selected) with:
  - Base URL input (default `http://122.116.209.1:8188`)
  - Checkpoint filename input
  - Custom workflow path input
  - Token input (password-style, with show/hide toggle like the LLM key)
- Load values into the form on settings open; send back on save via
  `saveLLMSettings`. Keep the existing "文生圖模型" behavior for AetherMesh
  when `imageEngine` is AetherMesh/auto.

### 5. Self-knowledge / prompts (no change needed)

The LLM keeps using `generate_image`. No prompt changes required.

## ComfyUI Side Setup (documentation only, not code)

Run on the Windows PC (GPU 1 = RTX 4070 Ti Super):

```bash
nvidia-smi -L                  # confirm 4070 is device 1
python main.py --listen 0.0.0.0 --port 8188 --cuda-device 1 --api-auth comfy:secret
```

- `--listen 0.0.0.0` exposes it to the LAN so the Mac can reach it.
- `--cuda-device 1` pins ComfyUI to the 4070; the 5090 stays free for AetherMesh.
- `--api-auth <user:pass>` protects remote access. The token field in BaiLongma
  maps to the `Authorization` header; whether ComfyUI expects `Bearer` or HTTP
  Basic is version-dependent and is verified during implementation.
- Optional: install ComfyUI as a Windows service / use `--dont-print-server` for
  headless operation.

## Testing

- `node --check` on every modified file.
- Unit-level checks:
  - Built-in workflow generation: assert latent size per aspect ratio, prompt
    injected into positive node, negative empty.
  - Custom workflow: assert a `PROMPT`-titled node is filled and other nodes
    unchanged; assert error when no `PROMPT` node exists.
- Live smoke (user-run): ComfyUI reachable from Mac → `generate_image` with
  `imageEngine=comfyui` produces an image in TUI; Telegram path sends the photo.

## Out of Scope

- Multi-instance ComfyUI (a second engine for the 5090) — later if needed.
- ComfyUI websocket progress streaming — polling `/history` is sufficient.
- Model installation/management on the ComfyUI host — user-managed.

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
  - Built-in generic text-to-image template that auto-selects between SD
    (`CheckpointLoaderSimple`, checkpoint from settings) and FLUX.1
    (`UNETLoader` + `DualCLIPLoader` + `VAELoader`, filenames auto-detected via
    `object_info`), with aspect-ratio → latent size conversion.
  - Optional custom workflow JSON: a `PROMPT`-titled `CLIPTextEncode` node is
    filled with the generated prompt; all other nodes are left untouched.
- Remote access token support (optional; see "ComfyUI Side Setup" — stock
  ComfyUI has no `--api-auth`, so the token is used when a reverse-proxy HTTP
  Basic layer or a custom-node auth layer is present).
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
   - Find the `CLIPTextEncode` node whose title is exactly `PROMPT` (case
     insensitive exact match — avoids mis-filling a `NegativePrompt` node).
     Fill its `inputs.text` with the prompt.
   - Error if no such node exists, or the JSON is invalid.
2. Otherwise use the built-in template. Template selection:
   - If `comfyuiCheckpoint` is set → SD template (explicit user choice).
   - Else query `GET {baseURL}/object_info` for `UNETLoader` / `CLIPLoader` /
     `VAELoader` (cached 60s). If a FLUX trio is present (a `flux`-named unet,
     a `t5`-named clip, a `clip_l`-named clip, a `flux`-named vae) → FLUX
     template. Else → SD template (empty checkpoint → `/prompt` returns a clear
     validation error).

**SD template** (`buildComfyWorkflow`, `CheckpointLoaderSimple`):

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

**FLUX template** (`buildFluxWorkflow`, for machines with FLUX.1 models and no
SD checkpoint). Node graph mirrors the official ComfyUI "FLUX.1 Schnell"
template (no `FluxGuidance`):

```
UNETLoader(flux1-schnell, weight_dtype=default) ────────────┐
DualCLIPLoader(t5xxl, clip_l, type=flux) ──> CLIPTextEncode(positive, text=prompt) ─┐
                                                                                     ▼
                                           BasicGuider(model, conditioning) ──> SamplerCustomAdvanced
RandomNoise(noise_seed) ────────────────────────────────────────────────────> /noise
KSamplerSelect(euler) ──────────────────────────────────────────────────────> /sampler
BasicScheduler(model, simple, steps 4, denoise 1) ──────────────────────────> /sigmas
EmptyLatentImage(w,h by aspect_ratio) ───────────────────────────────────────> /latent_image
VAELoader(flux_ae) ─────────────────────────────────────────────────────────> VAEDecode ─> SaveImage
```

- Filenames picked from `object_info` (any `flux` unet / `t5` clip / `clip_l`
  clip / `flux` vae), so schnell and dev both work.
- FLUX.1-schnell defaults: `KSamplerSelect` euler, `BasicScheduler` scheduler
  `simple`, steps 4, denoise 1.0 (the distilled model needs only 4 steps; no
  CFG / FluxGuidance).

#### HTTP flow (ComfyUI REST API)

1. `POST {baseURL}/prompt`
   - Headers: `Content-Type: application/json`. If `comfyuiToken` is set, send
     `Authorization: Basic base64(user:pass)` when the token contains `:` (for a
     reverse-proxy HTTP Basic layer), otherwise `Authorization: Bearer <token>`
     (for a custom-node/comfy-api auth layer). If empty, no `Authorization`
     header (trusted LAN; stock ComfyUI has no built-in auth).
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
set CUDA_DEVICE_ORDER=PCI_BUS_ID   # keep torch device ids aligned with nvidia-smi
python main.py --listen 0.0.0.0 --port 8188 --cuda-device 1
```

- `--listen 0.0.0.0` exposes it to the LAN so the Mac can reach it.
- `--cuda-device 1` pins ComfyUI to the 4070; the 5090 stays free for AetherMesh.
  Note: torch's default device ordering is `FASTEST_FIRST` (nvidia-smi uses
  `PCI_BUS_ID`), so a multi-GPU box may need `CUDA_DEVICE_ORDER=PCI_BUS_ID` set
  before launch to make `--cuda-device` indices match `nvidia-smi`. Verify by
  checking the "Device: cuda:X <GPU name>" line in the startup log.
- Stock ComfyUI has **no** `--api-auth` CLI flag (it errors with
  `unrecognized arguments`); the `--api-auth` / `--auth` / API-key flags come
  from community custom nodes and the ComfyUI Desktop app, not upstream
  `main.py`. This fork relies on a trusted LAN:
  - No auth (default): leave the BaiLongma Token field empty; the provider omits
    the `Authorization` header.
  - Optional HTTP Basic via a reverse proxy (Caddy/nginx) in front of port 8188;
    then the BaiLongma Token = `user:pass` and the provider sends
    `Authorization: Basic base64(user:pass)` (already implemented).
  - Optional `Authorization: Bearer <token>` if a custom-node/comfy-api auth layer
    is installed.
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

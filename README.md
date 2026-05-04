# VigyanBytes Home Cloud Backup Client

Migrate your personal files — photos, archives, documents, code — to your own home server.
AI-guided, fully offline, no cloud required.

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## What it does

- **Detects and classifies** your drives, folders, and archives (peeks inside without extracting)
- **AI decisions** via Phi-4-mini running locally — no data leaves your machine
- **Transfers** to the right destination (Immich for photos, Nextcloud for documents)
- **Guides you** through face tagging after import
- **Voice input** — say "add this folder", "next", "skip"
- **Telegram notifications** when jobs finish (optional)

---

## Prerequisites

Install these once before running the app.

### 1. Bun (JavaScript runtime)

The backend server (`vigyan-ext.js`) runs on Bun. Required for development and running tests.
Not needed if you are using a pre-built release binary.

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# Verify
bun --version   # must be 1.0 or later
```

### 2. llama-server (for AI mode)

Phi-4-mini runs via llama-server from the [llama.cpp](https://github.com/ggerganov/llama.cpp) project.
Download the build that matches your hardware:

| Your hardware | Build to download |
|---|---|
| NVIDIA GPU (any CUDA-capable) | `llama-*-bin-win-cuda-cu12.x-x64.zip` |
| Intel Arc / Core Ultra | `llama-*-bin-win-sycl-x64.zip` |
| AMD / other (Vulkan) | `llama-*-bin-win-vulkan-x64.zip` |
| macOS Apple Silicon | `llama-*-bin-macos-arm64.zip` |
| macOS Intel | `llama-*-bin-macos-x64.zip` |
| Linux (NVIDIA) | `llama-*-bin-ubuntu-x64-cuda.zip` |
| Any machine (CPU fallback) | `llama-*-bin-win-cpu-x64.zip` |

Download from: https://github.com/ggerganov/llama.cpp/releases/latest

Extract and note the path to `llama-server` (or `llama-server.exe` on Windows).
The app's setup wizard will ask for this path on first launch and test it automatically.

> **Already have Ollama?** Ollama ships `llama-server.exe` inside its install directory
> (e.g. `D:\ollama\llama-server.exe`). Point the setup wizard there — no separate download needed.

> **CPU-only machine?** The app works in rule-based mode without any llama-server.
> The AI assistant is optional. Rules handle ~80% of cases instantly.

### 3. Phi-4-mini model (~2.4 GB)

The model downloads automatically on first use if not bundled.
To pre-download manually:

```bash
# place next to the app binary (fully offline)
curl -L -o Phi-4-mini-instruct-Q4_K_M.gguf \
  "https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF/resolve/main/Phi-4-mini-instruct-Q4_K_M.gguf"
```

Or copy it from another machine that already downloaded it — no internet needed after that.

### 4. SSH key on your server

The app transfers files via rsync over SSH. Your laptop must be able to SSH into your server
without a password prompt.

```bash
# generate a key if you don't have one
ssh-keygen -t ed25519 -C "homecloud-client"

# copy it to your server
ssh-copy-id user@your-server-ip

# verify
ssh user@your-server-ip "echo ok"   # must print "ok" without asking for a password
```

### 5. Neutralinojs (for the native window — development only)

Required only if building from source. Pre-built releases include the binary.

```bash
npm install -g @neutralinojs/neu
neu --version   # must be 9.x or later
```

---

## Quick start (pre-built release)

1. Download the release zip for your platform from the [Releases](../../releases) page
2. Extract — you get a single folder with everything inside
3. Copy `Phi-4-mini-instruct-Q4_K_M.gguf` into the folder (or let it download on first launch)
4. Run:

```bash
# Windows
neutralino.exe

# macOS
./neutralino

# Linux
./neutralino
```

5. The setup wizard opens — follow the steps (GPU detect → llama-server path → done)

---

## Run from source

```bash
git clone https://github.com/manishknema/homecloud-client
cd homecloud-client

# start the backend
bun run start

# open resources/index.html in a browser (dev mode, no native window)
# or use the Neutralinojs window:
neu run
```

---

## Run tests

```bash
cd scripts/onboard

# create test fixtures (run once)
bun run make-fixtures

# all tests
bun test                                # JS unit + API tests
python3 -m pytest test/test-bot.py -v  # bot tests

# specific suites
bun run test:unit    # decision-engine only (fast, no server)
bun run test:api     # HTTP API tests (starts server on :3001)
bun run test:voice   # voice + Phi (Phi skipped if llama-server not running)
```

### Test environment variables

```bash
# bot tests — no real Telegram required
export NETDATA_TELEGRAM_BOT_TOKEN="test:ANYTOKEN"
export NETDATA_TELEGRAM_CHAT_ID="123456789"
export VIGYAN_BOT_USERS="123456789:yourname"
```

---

## Bundle contents (release zip)

```
vigyan-onboard/
  neutralino.exe              Windows webview shell (~3 MB)
  neutralino                  Linux / macOS webview shell
  vigyan-ext.exe              Backend server — Windows (self-contained, ~80 MB)
  vigyan-ext                  Backend server — Linux / macOS
  llama-server.exe            AI inference server (platform-specific build)
  Phi-4-mini-instruct-Q4_K_M.gguf   AI model (~2.4 GB, optional — downloads if missing)
  neutralino.config.json      App config
  resources/
    index.html                Full UI (all CSS/JS inline, zero CDN deps, works offline)
    logo.webp                 VigyanBytes branding
    favicon.png
```

No installation required. Unzip and run.

---

## Server requirements

Your home server needs:
- SSH access with key auth (no password)
- rsync installed (`apt install rsync`)
- Immich running (for photo import) — see [Immich docs](https://immich.app/docs/install/docker-compose)
- Nextcloud running (for documents) — optional
- Disk space for your data

The server does **not** need Bun, Node.js, Python, or any special software beyond SSH + rsync.

---

## Supported platforms

| Client (your laptop) | Server |
|---|---|
| Windows 10/11 x64 | Ubuntu 22.04 / Debian 12 |
| macOS 12+ (Apple Silicon) | Any Linux with SSH + rsync |
| macOS 12+ (Intel) | Raspberry Pi 4+ (arm64) |
| Ubuntu 22.04+ x64 | |

---

## GPU support for AI mode

| GPU | Backend | Performance |
|---|---|---|
| NVIDIA (4 GB+ VRAM) | CUDA | Fast — 2–5s per decision |
| Intel Arc / Core Ultra | SYCL/oneAPI | Fast — 3–8s per decision |
| AMD / other | Vulkan | Medium — 5–15s per decision |
| No GPU / CPU only | CPU | Slow — 30–90s (rule mode recommended) |

AI is only called for mixed/ambiguous content. Pure photo albums, music folders,
and code repositories are classified instantly by rules — GPU not needed for these.

---

## License

MIT — see [LICENSE](../../LICENSE)

Built by [VigyanBytes](https://vigyanbytes.in)

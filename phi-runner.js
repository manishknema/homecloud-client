#!/usr/bin/env bun
/**
 * phi-runner.js — Phi-4-mini launcher for VVC Onboard
 *
 * Responsibilities:
 *   - Detect available GPU (CUDA / Metal / Vulkan / CPU fallback)
 *   - Locate or download Phi-4-mini Q4_K_S GGUF
 *   - Start llama-server on fixed port with correct backend flags
 *   - Export: startPhi(), stopPhi(), phiReady()
 *
 * Zero npm deps — pure Bun built-ins.
 */

import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { writeFile } from 'fs/promises';

// ─── Config ───────────────────────────────────────────────────────────────────

const PHI_PORT      = 11434;
const MODEL_FILE    = 'Phi-4-mini-instruct-Q4_K_M.gguf';
const MODEL_SIZE_GB = 2.5;

// Model resolution order:
//   1. Same directory as this script/binary (bundled — preferred)
//   2. ~/.vigyan/models/ (cached from previous download)
//   3. Download from HuggingFace (last resort)
const MODEL_PATH_BUNDLED = join(import.meta.dir, MODEL_FILE);
const MODEL_PATH_CACHE   = join(homedir(), '.vigyan', 'models', MODEL_FILE);
const MODEL_PATH         = existsSync(MODEL_PATH_BUNDLED) ? MODEL_PATH_BUNDLED : MODEL_PATH_CACHE;
const MODEL_URL          = 'https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF/resolve/main/' + MODEL_FILE;

// llama-server binary — from config, env, or next to this script
function llamaBinPath() {
  // 1. Env override (e.g. LLAMA_SERVER_PATH=D:\ollama\llama-server.exe)
  if (process.env.LLAMA_SERVER_PATH) return process.env.LLAMA_SERVER_PATH;
  // 2. Persisted config (~/.vigyan/config.json)
  try {
    const cfg = JSON.parse(require('fs').readFileSync(join(homedir(), '.vigyan', 'config.json'), 'utf8'));
    if (cfg.llamaServerPath) return cfg.llamaServerPath;
  } catch {}
  // 3. Bundled binary next to this script
  const ext = platform() === 'win32' ? '.exe' : '';
  return join(import.meta.dir, `llama-server${ext}`);
}

const LLAMA_BIN = llamaBinPath();

// ─── GPU detection ────────────────────────────────────────────────────────────

export function detectGPU() {
  const os = platform();

  // macOS Apple Silicon → always Metal
  if (os === 'darwin') {
    try {
      const out = execSync('sysctl -n hw.optional.arm64 2>/dev/null', { encoding: 'utf8', timeout: 3000 }).trim();
      if (out === '1') return { backend: 'metal', gpuLayers: 99, label: 'Apple Silicon (Metal)' };
    } catch {}
    return { backend: 'cpu', gpuLayers: 0, label: 'Intel Mac (CPU)' };
  }

  // NVIDIA CUDA — highest priority on Linux + Windows
  try {
    const out = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim();
    if (out) {
      const [name, mem] = out.split(',').map(s => s.trim());
      const vram = parseInt(mem);          // MiB
      const layers = vram >= 8000 ? 99    // ≥8GB → full offload
                   : vram >= 4000 ? 28    // 4-8GB → partial
                   : 0;                   // <4GB → CPU fallback
      return { backend: 'cuda', gpuLayers: layers, label: `${name} CUDA (${Math.round(vram/1024)}GB VRAM)` };
    }
  } catch {}

  // SYCL — Intel Arc, Core Ultra, integrated (oneAPI build of llama.cpp)
  try {
    const syclBin = join(import.meta.dir, platform() === 'win32' ? 'llama-ls-sycl-device.exe' : 'llama-ls-sycl-device');
    const syclDir = existsSync(syclBin) ? import.meta.dir : null;
    // also check D:\ollama where user may have the sycl build
    const candidates = [syclBin, 'D:\\ollama\\llama-ls-sycl-device.exe'];
    for (const bin of candidates) {
      if (!existsSync(bin)) continue;
      const out = execSync(`"${bin}" 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
      if (out.includes('device')) {
        const match = out.match(/device\s+\d+.*?:\s*(.+)/i);
        const name  = match?.[1]?.trim() || 'Intel GPU';
        return { backend: 'sycl', gpuLayers: 99, label: `${name} (SYCL/oneAPI)` };
      }
    }
  } catch {}

  // Vulkan — AMD, any Vulkan-capable GPU
  try {
    const out = execSync('vulkaninfo --summary 2>/dev/null | head -20', { encoding: 'utf8', timeout: 5000 });
    if (out.includes('deviceName')) {
      const match = out.match(/deviceName\s*=\s*(.+)/);
      const name  = match?.[1]?.trim() || 'GPU';
      return { backend: 'vulkan', gpuLayers: 99, label: `${name} (Vulkan)` };
    }
  } catch {}

  // Windows DirectML fallback (Intel integrated, AMD without Vulkan)
  if (os === 'win32') {
    try {
      const out = execSync('powershell -Command "Get-WmiObject Win32_VideoController | Select-Object -ExpandProperty Name" 2>nul', { encoding: 'utf8', timeout: 5000 }).trim();
      if (out && !out.toLowerCase().includes('microsoft basic')) {
        return { backend: 'cpu', gpuLayers: 0, label: `${out.split('\n')[0]} (CPU — no Vulkan/CUDA)` };
      }
    } catch {}
  }

  return { backend: 'cpu', gpuLayers: 0, label: 'CPU only' };
}

// ─── Model download ───────────────────────────────────────────────────────────

export async function ensureModel(onProgress) {
  // bundled alongside binary — instant, no download
  if (existsSync(MODEL_PATH_BUNDLED)) {
    onProgress?.({ type: 'found', path: MODEL_PATH_BUNDLED, bundled: true });
    return MODEL_PATH_BUNDLED;
  }
  // cached from a previous download
  if (existsSync(MODEL_PATH_CACHE)) {
    onProgress?.({ type: 'found', path: MODEL_PATH_CACHE, bundled: false });
    return MODEL_PATH_CACHE;
  }

  mkdirSync(join(homedir(), '.vigyan', 'models'), { recursive: true });
  onProgress?.({ type: 'download_start', url: MODEL_URL, sizeGB: MODEL_SIZE_GB });

  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Model download failed: ${res.status} ${res.statusText}`);

  const total = parseInt(res.headers.get('content-length') || '0');
  let received = 0;
  const chunks = [];

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) {
      onProgress?.({ type: 'download_progress', received, total, pct: Math.round(received / total * 100) });
    }
  }

  const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
  await writeFile(MODEL_PATH_CACHE, buf);
  onProgress?.({ type: 'download_done', path: MODEL_PATH_CACHE });
  return MODEL_PATH_CACHE;
}

// ─── llama-server lifecycle ───────────────────────────────────────────────────

let _serverProcess = null;

export async function startPhi(onLog) {
  if (_serverProcess) return; // already running

  const gpu       = detectGPU();
  const modelPath = await ensureModel(onLog);

  onLog?.({ type: 'start', gpu: gpu.label });

  const args = [
    '--model',    modelPath,
    '--port',     String(PHI_PORT),
    '--host',     '127.0.0.1',
    '--ctx-size', '4096',
    '--threads',  String(Math.max(4, Math.min(8, navigator?.hardwareConcurrency || 4))),
    '-ngl',       String(gpu.gpuLayers),    // GPU layer offload
    '--log-disable',                         // suppress verbose llama log
  ];

  // Vulkan needs explicit backend flag in some llama.cpp builds
  if (gpu.backend === 'vulkan') args.push('--gpu-backend', 'vulkan');

  _serverProcess = spawn(LLAMA_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  _serverProcess.stdout.on('data', d => onLog?.({ type: 'log', text: d.toString() }));
  _serverProcess.stderr.on('data', d => onLog?.({ type: 'log', text: d.toString() }));
  _serverProcess.on('exit', code => {
    _serverProcess = null;
    onLog?.({ type: 'exit', code });
  });

  // wait for server ready (polls /health)
  await waitReady(30_000);
  onLog?.({ type: 'ready', port: PHI_PORT, gpu: gpu.label });
}

export function stopPhi() {
  if (_serverProcess) {
    _serverProcess.kill();
    _serverProcess = null;
  }
}

export async function phiReady() {
  try {
    const r = await fetch(`http://127.0.0.1:${PHI_PORT}/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch { return false; }
}

async function waitReady(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await phiReady()) return;
    await Bun.sleep(500);
  }
  throw new Error('llama-server did not become ready in time');
}

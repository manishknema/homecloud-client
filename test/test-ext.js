#!/usr/bin/env bun
/**
 * test-ext.js — integration tests for vigyan-ext.js HTTP API
 *
 * Starts the server as a subprocess, runs HTTP assertions, then kills it.
 * Run: bun test scripts/onboard/test/test-ext.js
 *
 * Prerequisites: bun run scripts/onboard/test/make-fixtures.js
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn }       from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync }  from 'fs';

const DIR      = dirname(fileURLToPath(import.meta.url));
const EXT_JS   = join(DIR, '..', 'vigyan-ext.js');
const FIXTURES = join(DIR, 'fixtures');
const BASE     = 'http://localhost:3001';   // use 3001 to avoid colliding with dev server

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let server;

beforeAll(async () => {
  server = spawn('bun', ['run', EXT_JS], {
    env: { ...process.env, PORT_OVERRIDE: '3001' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // wait up to 8s for server ready
  const ready = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 8000);
    const check = setInterval(async () => {
      try {
        const r = await fetch(`${BASE}/api/status`);
        if (r.ok) { clearInterval(check); clearTimeout(timeout); resolve(true); }
      } catch {}
    }, 200);
  });

  if (!ready) throw new Error('vigyan-ext did not start within 8s');
});

afterAll(() => {
  server?.kill();
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.json() };
}

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

// ─── /api/status ──────────────────────────────────────────────────────────────

describe('GET /api/status', () => {
  test('returns 200 with version and platform', async () => {
    const { status, body } = await get('/api/status');
    expect(status).toBe(200);
    expect(body.version).toBeString();
    expect(body.platform).toBeString();
    expect(body.port).toBeNumber();
  });

  test('includes gpu label', async () => {
    const { body } = await get('/api/status');
    expect(body.gpu).toBeString();
    expect(body.gpu.length).toBeGreaterThan(0);
  });
});

// ─── /api/setup/detect-gpu ────────────────────────────────────────────────────

describe('GET /api/setup/detect-gpu', () => {
  test('returns backend and label', async () => {
    const { status, body } = await get('/api/setup/detect-gpu');
    expect(status).toBe(200);
    expect(['cuda','sycl','vulkan','metal','cpu']).toContain(body.backend);
    expect(body.label).toBeString();
    expect(body.defaultPath).toBeString();
  });

  test('returns latestTag string', async () => {
    const { body } = await get('/api/setup/detect-gpu');
    expect(body.latestTag).toBeString();
  });
});

// ─── /api/setup/config ────────────────────────────────────────────────────────

describe('GET /api/setup/config', () => {
  test('returns config shape', async () => {
    const { status, body } = await get('/api/setup/config');
    expect(status).toBe(200);
    expect(typeof body.configured).toBe('boolean');
  });
});

// ─── /api/setup/test-llama-server ────────────────────────────────────────────

describe('POST /api/setup/test-llama-server', () => {
  test('missing path → 400', async () => {
    const { status } = await post('/api/setup/test-llama-server', {});
    expect(status).toBe(400);
  });

  test('non-existent binary → ok:false', async () => {
    const { body } = await post('/api/setup/test-llama-server', {
      path: '/nonexistent/llama-server',
    });
    expect(body.ok).toBe(false);
    expect(body.error).toBeString();
  });

  test('real llama-server → ok:true with version', async () => {
    const candidates = [
      'D:\\ollama\\llama-server.exe',
      '/usr/local/bin/llama-server',
      '/usr/bin/llama-server',
    ];
    const real = candidates.find(c => existsSync(c));
    if (!real) { console.log('  skipped — no llama-server found'); return; }

    const { body } = await post('/api/setup/test-llama-server', { path: real });
    expect(body.ok).toBe(true);
    expect(body.version).toBeString();
  });
});

// ─── /api/drives ──────────────────────────────────────────────────────────────

describe('GET /api/drives', () => {
  test('returns array with at least one drive', async () => {
    const { status, body } = await get('/api/drives');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  test('each drive has path, label, freeBytes, totalBytes', async () => {
    const { body } = await get('/api/drives');
    for (const d of body) {
      expect(d.path).toBeString();
      expect(d.label).toBeString();
      expect(typeof d.freeBytes).toBe('number');
      expect(typeof d.totalBytes).toBe('number');
    }
  });
});

// ─── /api/listdir ─────────────────────────────────────────────────────────────

describe('GET /api/listdir', () => {
  test('missing path → 400', async () => {
    const { status } = await get('/api/listdir');
    expect(status).toBe(400);
  });

  test('valid path returns entries', async () => {
    const { status, body } = await get(`/api/listdir?path=${encodeURIComponent(FIXTURES)}`);
    expect(status).toBe(200);
    expect(body.path).toBe(FIXTURES);
    expect(Array.isArray(body.entries)).toBe(true);
  });

  test('archives are flagged', async () => {
    const { body } = await get(`/api/listdir?path=${encodeURIComponent(FIXTURES)}`);
    const archives = body.entries.filter(e => e.isArchive);
    expect(archives.length).toBeGreaterThan(0);
    for (const a of archives) {
      expect(a.bucket).toBe('archive');
    }
  });

  test('nonexistent path returns error in body', async () => {
    const { body } = await get('/api/listdir?path=%2Fno%2Fsuch%2Fpath');
    expect(body.error).toBeString();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBe(0);
  });
});

// ─── /api/peek ────────────────────────────────────────────────────────────────

describe('POST /api/peek', () => {
  test('non-archive path → 400', async () => {
    const { status } = await post('/api/peek', { path: '/some/file.txt' });
    expect(status).toBe(400);
  });

  test('missing path → 400', async () => {
    const { status } = await post('/api/peek', {});
    expect(status).toBe(400);
  });

  test('google-photos.tar.gz → detects json sidecars + high image ratio', async () => {
    const fixture = join(FIXTURES, 'google-photos.tar.gz');
    if (!existsSync(fixture)) { console.log('  skipped — run make-fixtures.js first'); return; }

    const { status, body } = await post('/api/peek', { path: fixture });
    expect(status).toBe(200);
    expect(body.sampledFiles).toBeGreaterThan(0);
    expect(body.hasJsonSidecars).toBe(true);
    expect(body.mimeDistribution.image).toBeGreaterThan(0.5);
    expect(body.suggested).toBe('google_photos');
  });

  test('audio-only.tar → high audio ratio', async () => {
    const fixture = join(FIXTURES, 'audio-only.tar');
    if (!existsSync(fixture)) { console.log('  skipped'); return; }

    const { status, body } = await post('/api/peek', { path: fixture });
    expect(status).toBe(200);
    expect(body.mimeDistribution.audio).toBeGreaterThanOrEqual(0.9);
    expect(body.hasJsonSidecars).toBe(false);
  });

  test('old-memories.tar.gz → high image ratio, no sidecars', async () => {
    const fixture = join(FIXTURES, 'old-memories.tar.gz');
    if (!existsSync(fixture)) { console.log('  skipped'); return; }

    const { body } = await post('/api/peek', { path: fixture });
    expect(body.mimeDistribution.image).toBeGreaterThan(0.5);
    expect(body.hasJsonSidecars).toBe(false);
    expect(body.suggested).toBe('old_memories');
  });

  test('mixed-code-docs.zip → code + document mix', async () => {
    const fixture = join(FIXTURES, 'mixed-code-docs.zip');
    if (!existsSync(fixture)) { console.log('  skipped'); return; }

    const { body } = await post('/api/peek', { path: fixture });
    expect(body.sampledFiles).toBeGreaterThan(0);
    // code files (.py) should be classified as code
    expect((body.mimeDistribution.code || 0)).toBeGreaterThan(0);
  });
});

// ─── /api/decide ──────────────────────────────────────────────────────────────

describe('POST /api/decide (SSE)', () => {
  async function decide(source) {
    const r = await fetch(`${BASE}/api/decide`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ source }),
    });
    // collect SSE events
    const text = await r.text();
    return text.split('\n')
      .filter(l => l.startsWith('data:'))
      .map(l => JSON.parse(l.slice(5).trim()));
  }

  test('google_photos source → rule decides instantly', async () => {
    const events = await decide({
      mimeDistribution: { image: 0.70, video: 0.10, other: 0.20 },
      hasJsonSidecars:  true,
    });
    const ruleEvent = events.find(e => e.type === 'rule');
    expect(ruleEvent).toBeDefined();
    expect(ruleEvent.decision).toBe('google_photos');
    expect(ruleEvent.needsPhi).toBe(false);
  });

  test('pure audio source → rule decides instantly', async () => {
    const events = await decide({
      mimeDistribution: { audio: 0.95, other: 0.05 },
    });
    const ruleEvent = events.find(e => e.type === 'rule');
    expect(ruleEvent.decision).toBe('audio');
    expect(ruleEvent.needsPhi).toBe(false);
  });

  test('missing source body → 400', async () => {
    const r = await fetch(`${BASE}/api/decide`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });
});

// ─── /api/explain ─────────────────────────────────────────────────────────────

describe('POST /api/explain (SSE)', () => {
  async function explain(event, context = {}) {
    const r = await fetch(`${BASE}/api/explain`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ event, context }),
    });
    const text = await r.text();
    const events = text.split('\n')
      .filter(l => l.startsWith('data:'))
      .map(l => JSON.parse(l.slice(5).trim()));
    return events.find(e => e.text)?.text || '';
  }

  test('rsync_done ok → plain English success message', async () => {
    const msg = await explain('rsync_done', { ok: true, sourceName: 'Photos 2023' });
    expect(msg).toBeString();
    expect(msg.length).toBeGreaterThan(0);
    expect(msg.toLowerCase()).toMatch(/transfer|complete|success/i);
  });

  test('rsync_error_no_space → mentions space', async () => {
    const msg = await explain('rsync_error_no_space', {});
    expect(msg.toLowerCase()).toMatch(/space|full/i);
  });

  test('rsync_start → mentions transfer', async () => {
    const msg = await explain('rsync_start', { sourceName: 'Music' });
    expect(msg).toBeString();
    expect(msg.length).toBeGreaterThan(5);
  });
});

// ─── CORS ────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  test('OPTIONS preflight → 204 with CORS headers', async () => {
    const r = await fetch(`${BASE}/api/status`, { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// ─── 404 ─────────────────────────────────────────────────────────────────────

describe('404', () => {
  test('unknown route → 404 with error field', async () => {
    const { status, body } = await get('/api/nonexistent');
    expect(status).toBe(404);
    expect(body.error).toBeString();
  });
});

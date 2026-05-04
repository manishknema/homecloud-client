#!/usr/bin/env bun
/**
 * vigyan-ext.js — VVC Onboard backend (Bun HTTP + SSE)
 *
 * Neutralinojs webview points to http://localhost:3000
 * All filesystem ops run here — no browser sandbox.
 * Phi-4-mini called via decision-engine.js for ambiguous cases.
 * Progress streaming via SSE — same pattern as VVC dashboard.
 *
 * API:
 *   GET  /api/status
 *   GET  /api/drives
 *   GET  /api/listdir?path=
 *   POST /api/peek            { path }
 *   POST /api/decide          { source }        rule → Phi if ambiguous
 *   POST /api/start-rsync     { sources, vvcHost, vvcSshUser }
 *   GET  /api/progress/:jobId (SSE)
 *   POST /api/upload-survey   { survey, vvcHost, vvcSshUser }
 *   POST /api/explain         { event, context } plain English answer
 *   GET  /api/phi-status
 *
 * Zero npm deps — pure Bun + local modules.
 */

import { readdir, stat, open, writeFile, mkdir } from 'fs/promises';
import { existsSync }                             from 'fs';
import { createReadStream }                        from 'fs';
import { createGunzip }                            from 'zlib';
import { spawn, execSync }                         from 'child_process';
import { join, extname, basename }                 from 'path';
import { homedir, platform, tmpdir }               from 'os';
import { randomUUID }                              from 'crypto';

import { startPhi, stopPhi, phiReady, detectGPU, ensureModel } from './phi-runner.js';
import { ruleDecide, phiDecide, explainEvent }                  from './decision-engine.js';

// ─── Config (persisted to ~/.vigyan/config.json) ─────────────────────────────

const CONFIG_PATH = join(homedir(), '.vigyan', 'config.json');

async function loadConfig() {
  try {
    const text = await Bun.file(CONFIG_PATH).text();
    return JSON.parse(text);
  } catch { return {}; }
}

async function saveConfig(patch) {
  const cfg = await loadConfig();
  const next = { ...cfg, ...patch };
  await mkdir(join(homedir(), '.vigyan'), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

// ─── Setup helpers ────────────────────────────────────────────────────────────

// Fetch the latest llama.cpp release tag from GitHub
async function latestLlamaCppTag() {
  try {
    const r = await fetch('https://api.github.com/repos/ggerganov/llama.cpp/releases/latest',
      { headers: { 'User-Agent': 'vvc-onboard' }, signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    return d.tag_name || 'latest';
  } catch { return 'latest'; }
}

function llamaDefaultPath() {
  const os = platform();
  if (os === 'win32') {
    // common locations on Windows
    const candidates = [
      'D:\\ollama\\llama-server.exe',
      'C:\\ollama\\llama-server.exe',
      join(homedir(), 'llama.cpp', 'llama-server.exe'),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    return 'C:\\llama\\llama-server.exe';
  }
  if (os === 'darwin') return '/usr/local/bin/llama-server';
  return '/usr/local/bin/llama-server';
}

function testLlamaServerBinary(binPath) {
  try {
    const out = execSync(`"${binPath}" --version 2>&1`, { encoding: 'utf8', timeout: 5000 }).trim();
    const match = out.match(/version:\s*(\S+)/i);
    return { ok: true, version: out.split('\n')[0] || binPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const PORT = parseInt(process.env.PORT_OVERRIDE || '3000');

// ─── File classification ──────────────────────────────────────────────────────

const IMAGE_EXT   = new Set(['.jpg','.jpeg','.png','.heic','.heif','.raw','.cr2','.nef','.arw','.tif','.tiff','.bmp','.webp','.gif','.dng']);
const VIDEO_EXT   = new Set(['.mp4','.mov','.avi','.mkv','.m4v','.wmv','.flv','.webm','.3gp','.mts','.m2ts']);
const AUDIO_EXT   = new Set(['.mp3','.flac','.aac','.wav','.ogg','.m4a','.wma','.aiff','.opus']);
const CODE_EXT    = new Set(['.js','.ts','.py','.go','.java','.c','.cpp','.h','.rs','.rb','.php','.cs','.swift','.kt','.sh','.bash','.ps1','.sql','.vue','.jsx','.tsx']);
const DOC_EXT     = new Set(['.pdf','.docx','.doc','.xlsx','.xls','.pptx','.ppt','.txt','.md','.rtf','.odt','.csv','.epub','.pages','.numbers']);
const ARCHIVE_EXT = new Set(['.tar','.gz','.bz2','.xz','.tgz','.txz','.zip','.7z','.rar','.zst']);
const COMPOUND    = ['.tar.gz','.tar.bz2','.tar.xz','.tar.zst'];

function classify(name) {
  const lower = name.toLowerCase();
  for (const c of COMPOUND) if (lower.endsWith(c)) return 'archive';
  const ext = extname(lower);
  if (IMAGE_EXT.has(ext))   return 'image';
  if (VIDEO_EXT.has(ext))   return 'video';
  if (AUDIO_EXT.has(ext))   return 'audio';
  if (CODE_EXT.has(ext))    return 'code';
  if (DOC_EXT.has(ext))     return 'document';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if (lower.endsWith('.json')) return 'sidecar';
  return 'other';
}

function isArchive(p) {
  const lower = p.toLowerCase();
  for (const c of COMPOUND) if (lower.endsWith(c)) return true;
  return ARCHIVE_EXT.has(extname(lower));
}

// ─── Drive enumeration ────────────────────────────────────────────────────────

async function enumDrives() {
  const os = platform();
  if (os === 'win32') {
    try {
      const out = execSync('wmic logicaldisk get Name,Size,FreeSpace,VolumeName /format:csv', { encoding:'utf8', timeout:8000 });
      return out.split('\n')
        .map(l => l.trim().split(','))
        .filter(p => p.length >= 5 && /^[A-Z]:/.test(p[2]))
        .map(([,free,name,size,label]) => ({ path:name+'\\', label:label?.trim()||name, freeBytes:+free||0, totalBytes:+size||0 }));
    } catch {
      const drives = [];
      for (let c = 67; c <= 90; c++) { const p = String.fromCharCode(c)+':\\'; try { await stat(p); drives.push({path:p,label:p,freeBytes:0,totalBytes:0}); } catch {} }
      return drives;
    }
  }
  if (os === 'darwin') {
    try {
      const out = execSync('df -k', { encoding:'utf8', timeout:5000 });
      return out.split('\n').slice(1).map(l=>l.trim().split(/\s+/))
        .filter(p=>p.length>=6&&(p[5]==='/'||p[5]?.startsWith('/Volumes/')))
        .map(p=>({path:p[5],label:basename(p[5])||'/',freeBytes:+p[3]*1024||0,totalBytes:+p[1]*1024||0}));
    } catch { return [{path:homedir(),label:'Home',freeBytes:0,totalBytes:0}]; }
  }
  try {
    const out = execSync('df -k --output=target,avail,size 2>/dev/null', { encoding:'utf8', timeout:5000 });
    return out.split('\n').slice(1).map(l=>l.trim().split(/\s+/))
      .filter(p=>p.length>=3&&p[0]?.startsWith('/')&&!['/proc','/sys','/dev'].includes(p[0]))
      .map(p=>({path:p[0],label:basename(p[0])||'/',freeBytes:+p[1]*1024||0,totalBytes:+p[2]*1024||0}));
  } catch { return [{path:homedir(),label:'Home',freeBytes:0,totalBytes:0}]; }
}

// ─── Directory listing ────────────────────────────────────────────────────────

async function listDir(dirPath) {
  try {
    const items   = await readdir(dirPath, { withFileTypes: true });
    const entries = [];
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const full  = join(dirPath, item.name);
      const entry = { name: item.name, path: full, isDir: item.isDirectory() };
      if (!item.isDirectory()) {
        entry.bucket    = classify(item.name);
        entry.isArchive = entry.bucket === 'archive';
        try { entry.sizeBytes = (await stat(full)).size; } catch { entry.sizeBytes = 0; }
      }
      entries.push(entry);
    }
    const archives = entries.filter(e => e.isArchive);
    return { path: dirPath, entries, archives };
  } catch (e) {
    return { path: dirPath, entries: [], archives: [], error: e.message };
  }
}

// ─── Archive peek ─────────────────────────────────────────────────────────────

const MAX_SAMPLE = 500;

async function peekArchive(archivePath) {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.zip')) return peekZip(archivePath);
  return peekTar(archivePath);
}

async function peekTar(archivePath) {
  const lower  = archivePath.toLowerCase();
  const counts = {image:0,video:0,audio:0,code:0,document:0,sidecar:0,archive:0,other:0};
  let total = 0;

  const needsExec = lower.endsWith('.bz2')||lower.endsWith('.xz')||lower.endsWith('.txz');
  if (needsExec) {
    try {
      const flag = lower.endsWith('.bz2') ? 'j' : 'J';
      const out  = execSync(`tar t${flag}f "${archivePath}" 2>/dev/null | head -${MAX_SAMPLE}`, {encoding:'utf8',timeout:30000});
      for (const line of out.split('\n')) {
        if (!line.trim()||line.endsWith('/')) continue;
        counts[classify(line.trim())]++;
        total++;
      }
    } catch {}
    return buildPeekResult(counts, total, archivePath);
  }

  await new Promise(resolve => {
    const raw = createReadStream(archivePath);
    const src = (lower.endsWith('.gz')||lower.endsWith('.tgz')) ? raw.pipe(createGunzip()) : raw;
    let buf = Buffer.alloc(0), skipBytes = 0;
    const done = () => { try { src.destroy(); } catch {} resolve(); };
    src.on('error', resolve); src.on('end', resolve); src.on('close', resolve);
    src.on('data', chunk => {
      if (total >= MAX_SAMPLE) { done(); return; }
      if (skipBytes > 0) { if (chunk.length <= skipBytes) { skipBytes -= chunk.length; return; } chunk = chunk.slice(skipBytes); skipBytes = 0; }
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 512 && total < MAX_SAMPLE) {
        if (buf.slice(0,512).every(b=>b===0)) { done(); return; }
        const name = buf.slice(0,100).toString('utf8').replace(/\0/g,'').trim();
        const size = parseInt(buf.slice(124,136).toString('utf8').trim(), 8)||0;
        const skip = Math.ceil(size/512)*512;
        buf = buf.slice(512);
        if (name && !name.endsWith('/')) { counts[classify(name)]++; total++; }
        if (buf.length >= skip) { buf = buf.slice(skip); } else { skipBytes = skip-buf.length; buf = Buffer.alloc(0); }
      }
    });
  });
  return buildPeekResult(counts, total, archivePath);
}

async function peekZip(archivePath) {
  const counts = {image:0,video:0,audio:0,code:0,document:0,sidecar:0,archive:0,other:0};
  let total = 0;
  try {
    const out = execSync(`unzip -l "${archivePath}" 2>/dev/null | head -${MAX_SAMPLE+4}`, {encoding:'utf8',timeout:30000});
    for (const line of out.split('\n').slice(3)) {
      const parts = line.trim().split(/\s{2,}/);
      const name  = parts[parts.length-1];
      if (!name||name.endsWith('/')||name.startsWith('---')) continue;
      counts[classify(name)]++;
      if (++total >= MAX_SAMPLE) break;
    }
    return buildPeekResult(counts, total, archivePath);
  } catch {}
  // manual ZIP header scan fallback
  const fh = await open(archivePath, 'r');
  const hdr = Buffer.alloc(30);
  let offset = 0;
  try {
    while (total < MAX_SAMPLE) {
      const { bytesRead } = await fh.read(hdr, 0, 30, offset);
      if (bytesRead < 30 || hdr.readUInt32LE(0) !== 0x04034b50) break;
      const compSize = hdr.readUInt32LE(18), fnLen = hdr.readUInt16LE(26), exLen = hdr.readUInt16LE(28);
      const nb = Buffer.alloc(fnLen);
      await fh.read(nb, 0, fnLen, offset+30);
      const name = nb.toString('utf8');
      if (!name.endsWith('/')) { counts[classify(name)]++; total++; }
      offset += 30 + fnLen + exLen + compSize;
    }
  } finally { await fh.close(); }
  return buildPeekResult(counts, total, archivePath);
}

function buildPeekResult(counts, total, archivePath) {
  const dist = {};
  if (total > 0) for (const [k,v] of Object.entries(counts)) if (v>0) dist[k] = Math.round(v/total*100)/100;
  const img = ((dist.image||0)+(dist.video||0))*100;
  const suggested =
    img>70 && counts.sidecar>0 ? 'google_photos'  :
    img>70                     ? 'old_memories'   :
    (dist.code||0)>0.5        ? 'code'           :
    (dist.audio||0)>0.5       ? 'audio'          : 'general_backup';
  return { archivePath, sampledFiles:total, mimeDistribution:dist, hasJsonSidecars:counts.sidecar>0, suggested };
}

// ─── Immich status (ML jobs + people) ────────────────────────────────────────

async function immichStatus(vvcHost) {
  const base    = `http://${vvcHost}:2283`;
  const apiKey  = await getImmichApiKey(vvcHost);
  if (!apiKey) return { error: 'no api key', mlDone: false };

  const headers = { 'x-api-key': apiKey };

  // job status
  const jobsRes  = await fetch(`${base}/api/jobs`, { headers, signal: AbortSignal.timeout(5000) });
  const jobsData = await jobsRes.json();
  const faceJob  = jobsData?.['facial-recognition'] || {};
  const mlDone   = faceJob.jobCounts?.active === 0 && faceJob.jobCounts?.waiting === 0;
  const total    = (faceJob.jobCounts?.active||0) + (faceJob.jobCounts?.waiting||0);
  const mlPct    = total === 0 ? 100 : Math.round((faceJob.jobCounts?.completed||0) / Math.max(1, (faceJob.jobCounts?.completed||0) + total) * 100);

  // people
  const peopleRes  = await fetch(`${base}/api/people?withHidden=false`, { headers, signal: AbortSignal.timeout(5000) });
  const peopleData = await peopleRes.json();
  const people     = (peopleData?.people || []).map(p => ({ id: p.id, name: p.name || '', faceCount: p.faces?.length || 0 }));

  return { mlDone, mlPct, jobStatus: faceJob.status || 'unknown',
           totalPeople: people.length, people, error: null };
}

async function getImmichApiKey(vvcHost) {
  // read from VVC config via SSH — stored in /etc/vigyan/secret.d/immich.env
  try {
    const out = execSync(
      `ssh ${vvcHost} "grep IMMICH_API_KEY /etc/vigyan/secret.d/immich.env 2>/dev/null | cut -d= -f2"`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    return out || null;
  } catch { return null; }
}

// ─── Job registry (rsync via SSE) ────────────────────────────────────────────

const jobs = new Map();

function createJob() {
  const id = randomUUID();
  jobs.set(id, { lines:[], subs:new Set(), done:false, ok:false });
  return id;
}

function pushLine(jobId, line) {
  const job = jobs.get(jobId); if (!job) return;
  job.lines.push(line);
  for (const sub of job.subs) sub(line);
}

function finishJob(jobId, ok) {
  const job = jobs.get(jobId); if (!job) return;
  job.done = true; job.ok = ok;
  pushLine(jobId, ok ? '\n✅ Transfer complete\n' : '\n❌ Transfer failed\n');
  for (const sub of job.subs) sub(null);
}

// ─── Rsync launcher ───────────────────────────────────────────────────────────

function launchRsync(jobId, source, vvcHost, vvcSshUser, destPath) {
  const isWin = platform() === 'win32';
  const [cmd, args] = isWin
    ? ['rclone', ['copy','--progress',`--sftp-host=${vvcHost}`,`--sftp-user=${vvcSshUser}`, source, `:sftp:${destPath}`]]
    : ['rsync',  ['-avhP','--stats', `${source}/`, `${vvcSshUser}@${vvcHost}:${destPath}/`]];

  const proc = spawn(cmd, args, { stdio:['ignore','pipe','pipe'] });
  proc.stdout.on('data', d => pushLine(jobId, d.toString()));
  proc.stderr.on('data', d => pushLine(jobId, d.toString()));
  proc.on('close', code => finishJob(jobId, code===0));
}

// ─── Survey upload ────────────────────────────────────────────────────────────

async function uploadSurvey(survey, vvcHost, vvcSshUser) {
  const tmp        = join(tmpdir(), `vvc-survey-${Date.now()}.json`);
  const remoteDir  = `/var/local/vigyan/onboard/${survey.user}`;
  const remotePath = `${remoteDir}/survey.json`;
  await writeFile(tmp, JSON.stringify(survey, null, 2));
  execSync(`ssh ${vvcSshUser}@${vvcHost} "mkdir -p ${remoteDir}"`, { timeout:10000 });
  execSync(`scp "${tmp}" "${vvcSshUser}@${vvcHost}:${remotePath}"`, { timeout:15000 });
  try {
    const srcSummary = JSON.stringify(survey.sources||[]).replace(/"/g, '\\"');
    const total = (survey.sources||[]).reduce((s,x)=>s+(x.sizeBytes||0),0);
    execSync(
      `ssh ${vvcSshUser}@${vvcHost} "curl -sf -X POST http://localhost:8889/api/onboard/survey-ready ` +
      `-H 'Content-Type: application/json' ` +
      `-d '{\\"user\\":\\"${survey.user}\\",\\"sources\\":${srcSummary},\\"totalBytes\\":${total}}'"`,
      {timeout:8000}
    );
  } catch {}
  return remotePath;
}

// ─── Phi tool handler (called by decision-engine phiDecide) ──────────────────

async function handlePhiTool(toolName, args) {
  switch (toolName) {
    case 'enumerate_drives': return await enumDrives();
    case 'list_dir':         return await listDir(args.path);
    case 'peek_archive':     return await peekArchive(args.path);
    default:                 return { error: `Unknown tool: ${toolName}` };
  }
}

// ─── SSE helper ──────────────────────────────────────────────────────────────

function sseStream(populate) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(ctrl) {
      const send = (data) => {
        if (data === null) { ctrl.close(); return; }
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      try { await populate(send); } catch (e) { send({ error: e.message }); ctrl.close(); }
    },
  });
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (data, status=200) =>
  new Response(JSON.stringify(data), { status, headers:{ ...CORS, 'Content-Type':'application/json' } });

const err  = (msg, status=400) => json({ error: msg }, status);

const sse  = (stream) =>
  new Response(stream, { headers:{ ...CORS, 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache' } });

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url  = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS') return new Response(null, { status:204, headers:CORS });

    // ── Setup: read config ────────────────────────────────────────────────────
    if (path === '/api/setup/config' && req.method === 'GET') {
      const cfg = await loadConfig();
      return json({
        configured:      !!(cfg.aiMode),
        aiMode:          cfg.aiMode || null,
        llamaServerPath: cfg.llamaServerPath || null,
      });
    }

    // ── Setup: GPU detect + recommended build ─────────────────────────────────
    if (path === '/api/setup/detect-gpu' && req.method === 'GET') {
      const gpu       = detectGPU();
      const latestTag = await latestLlamaCppTag();
      return json({
        ...gpu,
        latestTag,
        defaultPath: llamaDefaultPath(),
      });
    }

    // ── Setup: test llama-server binary ───────────────────────────────────────
    if (path === '/api/setup/test-llama-server' && req.method === 'POST') {
      const { path: binPath } = await req.json();
      if (!binPath) return err('path required');
      return json(testLlamaServerBinary(binPath));
    }

    // ── Setup: save config ────────────────────────────────────────────────────
    if (path === '/api/setup/save-config' && req.method === 'POST') {
      const { aiMode, llamaServerPath } = await req.json();
      if (!aiMode) return err('aiMode required');
      const cfg = await saveConfig({ aiMode, llamaServerPath: llamaServerPath || null });
      return json({ ok: true, config: cfg });
    }

    // ── Status ────────────────────────────────────────────────────────────────
    if (path === '/api/status') {
      const gpu    = detectGPU();
      const phiOk  = await phiReady();
      return json({ version:'1.0.0', platform:platform(), bunVersion:Bun.version, port:PORT, gpu:gpu.label, phiReady:phiOk });
    }

    // ── Immich status (ML + people) ───────────────────────────────────────────
    if (path === '/api/immich-status' && req.method === 'GET') {
      const host = url.searchParams.get('host');
      if (!host) return err('host required');
      try { return json(await immichStatus(host)); }
      catch (e) { return err(e.message, 500); }
    }

    // ── Phi status ────────────────────────────────────────────────────────────
    if (path === '/api/phi-status') {
      const ready = await phiReady();
      const gpu   = detectGPU();
      return json({ ready, gpu:gpu.label, backend:gpu.backend });
    }

    // ── Drives ────────────────────────────────────────────────────────────────
    if (path === '/api/drives' && req.method === 'GET') {
      return json(await enumDrives());
    }

    // ── List dir ──────────────────────────────────────────────────────────────
    if (path === '/api/listdir' && req.method === 'GET') {
      const p = url.searchParams.get('path');
      if (!p) return err('path required');
      return json(await listDir(p));
    }

    // ── Peek archive ──────────────────────────────────────────────────────────
    if (path === '/api/peek' && req.method === 'POST') {
      const { path: ap } = await req.json();
      if (!ap || !isArchive(ap)) return err('not an archive path');
      return json(await peekArchive(ap));
    }

    // ── Decide (rule → Phi if ambiguous) — SSE ────────────────────────────────
    if (path === '/api/decide' && req.method === 'POST') {
      const { source } = await req.json();
      if (!source) return err('source required');

      const stream = sseStream(async (send) => {
        const rule = ruleDecide(source);
        send({ type:'rule', ...rule });

        if (!rule.needsPhi) { send(null); return; }

        // respect rules-only mode from config
        const cfg = await loadConfig();
        if (cfg.aiMode === 'rules-only') {
          send({ type:'phi_unavailable', fallback:'general_backup', reason:'Rule-based mode — AI disabled by user preference' });
          send(null); return;
        }

        // check Phi available
        if (!await phiReady()) {
          send({ type:'phi_unavailable', fallback:'general_backup', reason:'Phi not running — using rule-based fallback' });
          send(null); return;
        }

        send({ type:'phi_thinking' });
        const result = await phiDecide(source, handlePhiTool, (text) => send({ type:'phi_token', text }));
        send({ type:'phi_result', ...result });
        send(null);
      });

      return sse(stream);
    }

    // ── Start rsync — returns jobId immediately ────────────────────────────────
    if (path === '/api/start-rsync' && req.method === 'POST') {
      const { source, destPath, vvcHost, vvcSshUser } = await req.json();
      if (!source||!destPath||!vvcHost||!vvcSshUser) return err('missing fields');
      const jobId = createJob();
      setImmediate(() => launchRsync(jobId, source, vvcHost, vvcSshUser, destPath));
      return json({ jobId });
    }

    // ── Progress SSE ──────────────────────────────────────────────────────────
    if (path.startsWith('/api/progress/') && req.method === 'GET') {
      const jobId = path.slice('/api/progress/'.length);
      const job   = jobs.get(jobId);
      if (!job) return err('job not found', 404);

      const stream = sseStream(async (send) => {
        for (const line of job.lines) send({ line });
        if (job.done) { send(null); return; }
        const cb = (line) => { if (line === null) send(null); else send({ line }); };
        job.subs.add(cb);
        req.signal.addEventListener('abort', () => { job.subs.delete(cb); });
        // keep alive until done
        await new Promise(resolve => { const t = setInterval(() => { if (job.done) { clearInterval(t); resolve(); } }, 500); });
      });

      return sse(stream);
    }

    // ── Upload survey ─────────────────────────────────────────────────────────
    if (path === '/api/upload-survey' && req.method === 'POST') {
      const { survey, vvcHost, vvcSshUser } = await req.json();
      if (!survey||!vvcHost||!vvcSshUser) return err('missing fields');
      try { return json({ ok:true, remotePath: await uploadSurvey(survey, vvcHost, vvcSshUser) }); }
      catch (e) { return err(e.message, 500); }
    }

    // ── Explain event — plain English via rule or Phi ─────────────────────────
    if (path === '/api/explain' && req.method === 'POST') {
      const { event, context } = await req.json();
      const stream = sseStream(async (send) => {
        await explainEvent(event, context||{}, (text) => send({ text }));
        send(null);
      });
      return sse(stream);
    }

    // ── Phi init (start llama-server + download model if needed) SSE ──────────
    if (path === '/api/phi-init' && req.method === 'POST') {
      const stream = sseStream(async (send) => {
        try {
          await startPhi((evt) => send(evt));
          send({ type:'ready' });
        } catch (e) {
          send({ type:'error', message: e.message });
        }
        send(null);
      });
      return sse(stream);
    }

    // ── Onboard action (dedup/enhance/migrate) → SSH → bot.py confirm ──────────
    if (path === '/api/onboard/action' && req.method === 'POST') {
      const {action, user, vvcHost, vvcSshUser} = await req.json();
      if (!action || !vvcHost || !vvcSshUser) return err('missing fields');
      const valid = ['dedup-fast','dedup-slow','enhance','migrate-nc'];
      if (!valid.includes(action)) return err('unknown action');
      const payload = JSON.stringify({action, user}).replace(/"/g, '\\"');
      try {
        execSync(
          `ssh ${vvcSshUser}@${vvcHost} ` +
          `"curl -sf -X POST http://localhost:8889/api/onboard/action ` +
          `-H 'Content-Type: application/json' -d '${payload}'"`,
          {timeout: 10000}
        );
        return json({ok: true});
      } catch(e) {
        return err('VVC unreachable: ' + e.message, 502);
      }
    }

    return err('not found', 404);
  },
});

console.log(`[vigyan-ext] http://localhost:${PORT}`);
console.log(`[vigyan-ext] GPU: ${detectGPU().label}`);

// graceful shutdown
process.on('SIGINT',  () => { stopPhi(); process.exit(0); });
process.on('SIGTERM', () => { stopPhi(); process.exit(0); });

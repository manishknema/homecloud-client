#!/usr/bin/env bun
/**
 * make-fixtures.js — creates test archive fixtures
 * Run once: bun run scripts/onboard/test/make-fixtures.js
 *
 * Creates:
 *   fixtures/google-photos.tar.gz  — 30 jpg + 10 json sidecars
 *   fixtures/audio-only.tar        — 20 mp3 files
 *   fixtures/mixed-code-docs.zip   — 15 .py + 5 .md files
 *   fixtures/old-memories.tar.gz   — 50 jpg/heic, no sidecars
 */

import { execSync }       from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname }  from 'path';
import { fileURLToPath }  from 'url';

const DIR  = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TMP  = join(DIR, '_tmp');

mkdirSync(DIR, { recursive: true });
mkdirSync(TMP, { recursive: true });

function tar(outFile, srcDir, compress = false) {
  const flag = compress ? 'czf' : 'cf';
  execSync(`tar ${flag} "${outFile}" -C "${srcDir}" .`, { stdio: 'ignore' });
}

function zip(outFile, srcDir) {
  // use powershell on windows, zip on unix
  if (process.platform === 'win32') {
    execSync(`powershell -Command "Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${outFile}' -Force"`, { stdio: 'ignore' });
  } else {
    execSync(`cd "${srcDir}" && zip -r "${outFile}" .`, { stdio: 'ignore', shell: true });
  }
}

function stub(path, content = 'stub') { writeFileSync(path, content); }

// ── google-photos.tar.gz ─────────────────────────────────────────────────────
{
  const src = join(TMP, 'google-photos');
  mkdirSync(src, { recursive: true });
  for (let i = 0; i < 30; i++) stub(join(src, `IMG_${i}.jpg`), `\xff\xd8\xff`);
  for (let i = 0; i < 10; i++) stub(join(src, `IMG_${i}.jpg.json`), `{"title":"photo${i}"}`);
  tar(join(DIR, 'google-photos.tar.gz'), src, true);
  console.log('✓ google-photos.tar.gz');
}

// ── audio-only.tar ───────────────────────────────────────────────────────────
{
  const src = join(TMP, 'audio');
  mkdirSync(src, { recursive: true });
  for (let i = 0; i < 20; i++) stub(join(src, `track${String(i).padStart(2,'0')}.mp3`), 'ID3');
  tar(join(DIR, 'audio-only.tar'), src, false);
  console.log('✓ audio-only.tar');
}

// ── old-memories.tar.gz ──────────────────────────────────────────────────────
{
  const src = join(TMP, 'memories');
  mkdirSync(src, { recursive: true });
  for (let i = 0; i < 35; i++) stub(join(src, `photo${i}.jpg`), `\xff\xd8\xff`);
  for (let i = 0; i < 15; i++) stub(join(src, `scan${i}.heic`), 'stub');
  tar(join(DIR, 'old-memories.tar.gz'), src, true);
  console.log('✓ old-memories.tar.gz');
}

// ── mixed-code-docs.zip ──────────────────────────────────────────────────────
{
  const src = join(TMP, 'code-docs');
  mkdirSync(join(src, 'src'), { recursive: true });
  mkdirSync(join(src, 'docs'), { recursive: true });
  for (let i = 0; i < 15; i++) stub(join(src, 'src', `module${i}.py`), `# module ${i}`);
  for (let i = 0; i < 5; i++)  stub(join(src, 'docs', `readme${i}.md`), `# readme ${i}`);
  zip(join(DIR, 'mixed-code-docs.zip'), src);
  console.log('✓ mixed-code-docs.zip');
}

// cleanup tmp
rmSync(TMP, { recursive: true, force: true });
console.log('\nAll fixtures ready in', DIR);

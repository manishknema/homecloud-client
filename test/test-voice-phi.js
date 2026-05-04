#!/usr/bin/env bun
/**
 * test-voice-phi.js — Voice intent matching + Phi interpretation tests
 *
 * Two tiers:
 *   Tier 1 (CI-safe): rule-based voice phrase matching — no GPU, no mic
 *   Tier 2 (device):  Phi interprets ambiguous utterances — requires llama-server
 *
 * Run all:   bun test scripts/onboard/test/test-voice-phi.js
 * Tier 1:    bun test --grep "rule-match" scripts/onboard/test/test-voice-phi.js
 * Tier 2:    bun test --grep "phi-voice"  scripts/onboard/test/test-voice-phi.js
 */

import { describe, test, expect, beforeAll } from 'bun:test';

// ── Voice rule matcher (mirrors logic in index.html) ─────────────────────────
// Extracted here so it can be unit-tested without a browser.

const VOICE_RULES = [
  { patterns: ['next','continue','proceed','go ahead'],   action: 'next'          },
  { patterns: ['back','previous','go back'],              action: 'back'          },
  { patterns: ['connect','connect to','ssh'],             action: 'connect'       },
  { patterns: ['add folder','add this','include folder'], action: 'add_folder'    },
  { patterns: ['skip','skip this','ignore'],              action: 'skip'          },
  { patterns: ['peek','check inside','what is inside'],   action: 'peek'          },
  { patterns: ['remove','delete source','remove source'], action: 'remove_source' },
  { patterns: ['start transfer','begin transfer','go'],   action: 'start_transfer'},
  { patterns: ['cancel','stop','abort'],                  action: 'cancel'        },
  { patterns: ['status','what is happening','progress'],  action: 'status'        },
];

function ruleMatchVoice(transcript) {
  const t = transcript.toLowerCase().trim();
  for (const rule of VOICE_RULES) {
    for (const p of rule.patterns) {
      if (t === p || t.includes(p)) return { action: rule.action, matched: p };
    }
  }
  return null;
}

// ── Tier 1: Rule-based matching (CI-safe) ────────────────────────────────────

describe('[rule-match] exact phrases', () => {
  test('"next" → next', () => {
    expect(ruleMatchVoice('next')).toMatchObject({ action: 'next' });
  });
  test('"go back" → back', () => {
    expect(ruleMatchVoice('go back')).toMatchObject({ action: 'back' });
  });
  test('"add this folder" → add_folder', () => {
    expect(ruleMatchVoice('add this folder')).toMatchObject({ action: 'add_folder' });
  });
  test('"check inside" → peek', () => {
    expect(ruleMatchVoice('check inside')).toMatchObject({ action: 'peek' });
  });
  test('"start transfer" → start_transfer', () => {
    expect(ruleMatchVoice('start transfer')).toMatchObject({ action: 'start_transfer' });
  });
  test('"abort" → cancel', () => {
    expect(ruleMatchVoice('abort')).toMatchObject({ action: 'cancel' });
  });
});

describe('[rule-match] embedded phrases (natural speech)', () => {
  test('"please go to next step" → next', () => {
    expect(ruleMatchVoice('please go to next step')).toMatchObject({ action: 'next' });
  });
  test('"can you add this folder for me" → add_folder', () => {
    expect(ruleMatchVoice('can you add this folder for me')).toMatchObject({ action: 'add_folder' });
  });
  test('"i want to skip this one" → skip', () => {
    expect(ruleMatchVoice('i want to skip this one')).toMatchObject({ action: 'skip' });
  });
  test('"show me the status" → status', () => {
    expect(ruleMatchVoice('show me the status')).toMatchObject({ action: 'status' });
  });
});

describe('[rule-match] no match → null', () => {
  test('ambiguous "add my photos from the backup drive" → null', () => {
    expect(ruleMatchVoice('add my photos from the backup drive')).toBeNull();
  });
  test('question "where will this go" → null', () => {
    expect(ruleMatchVoice('where will this go')).toBeNull();
  });
  test('empty string → null', () => {
    expect(ruleMatchVoice('')).toBeNull();
  });
});

// ── Tier 2: Phi voice interpretation (device — requires llama-server) ─────────

const PHI_PORT = 11434;
const PHI_URL  = `http://127.0.0.1:${PHI_PORT}/v1/chat/completions`;

const ACTIONS = ['next','back','connect','add_folder','skip','peek',
                 'remove_source','start_transfer','cancel','status','unknown'];

async function phiInterpretVoice(transcript) {
  const body = {
    model:       'phi-4-mini',
    messages: [
      {
        role:    'system',
        content: `You are the voice assistant for VigyanBytes Home Cloud Backup Client.
Map the user's spoken words to exactly one action from this list: ${ACTIONS.join(', ')}.
Available context: user is on a file migration screen, can browse drives, add folders, start transfers.
Respond with ONLY a JSON object: {"action":"<action>","params":{},"confidence":0.0-1.0}
Never add explanation.`,
      },
      { role: 'user', content: `User said: "${transcript}"` },
    ],
    temperature: 0.1,
    max_tokens:  60,
  };

  const res = await fetch(PHI_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`Phi returned ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  try {
    // Phi may wrap JSON in markdown — strip it
    const clean = text.replace(/```json?/g,'').replace(/```/g,'').trim();
    return JSON.parse(clean);
  } catch {
    return { action: 'unknown', confidence: 0 };
  }
}

let phiAvailable = false;

beforeAll(async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PHI_PORT}/health`,
                          { signal: AbortSignal.timeout(1000) });
    phiAvailable = r.ok;
  } catch { phiAvailable = false; }
  if (!phiAvailable) console.log('  [phi-voice] llama-server not running — Phi tests will skip');
});

function phiTest(name, fn) {
  test(name, async () => {
    if (!phiAvailable) {
      console.log(`  skipped (no llama-server): ${name}`);
      return;
    }
    await fn();
  });
}

describe('[phi-voice] natural language → structured action', () => {
  phiTest('add photos from D drive → add_folder', async () => {
    const r = await phiInterpretVoice('add my photos from the D drive');
    expect(ACTIONS).toContain(r.action);
    expect(r.action).toBe('add_folder');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  phiTest('where will this go → unknown or status', async () => {
    const r = await phiInterpretVoice('where will this go?');
    expect(ACTIONS).toContain(r.action);
    // should be unknown or status — not a destructive action
    expect(['unknown','status','peek']).toContain(r.action);
  });

  phiTest('start moving files → start_transfer', async () => {
    const r = await phiInterpretVoice('okay start moving the files to VVC');
    expect(r.action).toBe('start_transfer');
  });

  phiTest("I don't want this one → skip", async () => {
    const r = await phiInterpretVoice("I don't want this folder");
    expect(['skip','remove_source']).toContain(r.action);
  });

  phiTest('gibberish → unknown with low confidence', async () => {
    const r = await phiInterpretVoice('blargh flurb zomzom');
    expect(r.action).toBe('unknown');
    expect(r.confidence).toBeLessThan(0.5);
  });

  phiTest('response always valid JSON action', async () => {
    const phrases = [
      'go to the next screen',
      'check what is inside this archive',
      'remove the last source I added',
      'stop everything',
    ];
    for (const p of phrases) {
      const r = await phiInterpretVoice(p);
      expect(ACTIONS).toContain(r.action);
      expect(typeof r.confidence).toBe('number');
    }
  });
});

/**
 * decision-engine.js — rule-based + Phi-4-mini decisions for VVC Onboard
 *
 * Two-tier design:
 *   Tier 1 — rule engine:  handles ~90% of cases instantly, zero LLM cost
 *   Tier 2 — Phi-4-mini:  called only when rules are genuinely ambiguous
 *
 * Phi is called via llama-server OpenAI-compatible API with tool definitions.
 * Tool results are fed back to Phi which responds in plain English.
 */

const PHI_PORT = 11434;
const PHI_URL  = `http://127.0.0.1:${PHI_PORT}/v1/chat/completions`;

// ─── Tier 1: Rule engine ──────────────────────────────────────────────────────

// Confidence thresholds
const HIGH = 0.70;   // rule decides, no Phi needed
const LOW  = 0.40;   // hand off to Phi

/**
 * Decide what to do with a source based on MIME distribution.
 * Returns { decision, confidence, reason, needsPhi }
 */
export function ruleDecide(source) {
  const { mimeDistribution: d = {}, hasJsonSidecars, userType, entryType } = source;

  const img  = (d.image  || 0) * 100;
  const vid  = (d.video  || 0) * 100;
  const aud  = (d.audio  || 0) * 100;
  const doc  = (d.document || 0) * 100;
  const code = (d.code   || 0) * 100;
  const arc  = (d.archive || 0) * 100;
  const media = img + vid;

  // ── Google Photos: strong signal ──────────────────────────────────────────
  if (hasJsonSidecars && media > 60) return {
    decision:   'google_photos',
    pipeline:   ['czkawka', 'immich_import'],
    confidence: 0.95,
    reason:     'JSON sidecars detected alongside media — Google Photos export',
    needsPhi:   false,
  };

  // ── User already typed a type — trust it if media split is plausible ──────
  if (userType && media > 20) return {
    decision:   userType,
    pipeline:   pipelineFor(userType),
    confidence: 0.75,
    reason:     `User tagged as ${userType}, ${Math.round(media)}% media`,
    needsPhi:   false,
  };

  // ── Pure media without sidecars ───────────────────────────────────────────
  if (media >= HIGH * 100) return {
    decision:   'old_memories',
    pipeline:   ['czkawka', 'exiftool_pass', 'immich_import', 'esrgan_eligible'],
    confidence: 0.85,
    reason:     `${Math.round(media)}% photos/videos — old memories`,
    needsPhi:   false,
  };

  // ── Pure audio ─────────────────────────────────────────────────────────────
  if (aud > HIGH * 100) return {
    decision:   'audio',
    pipeline:   ['archive_audio'],
    confidence: 0.90,
    reason:     `${Math.round(aud)}% audio files`,
    needsPhi:   false,
  };

  // ── Pure code ─────────────────────────────────────────────────────────────
  if (code > HIGH * 100) return {
    decision:   'code',
    pipeline:   ['git_detect', 'archive_code'],
    confidence: 0.90,
    reason:     `${Math.round(code)}% code files`,
    needsPhi:   false,
  };

  // ── Pure documents ────────────────────────────────────────────────────────
  if (doc > HIGH * 100) return {
    decision:   'documents',
    pipeline:   ['nc_sync'],
    confidence: 0.85,
    reason:     `${Math.round(doc)}% documents`,
    needsPhi:   false,
  };

  // ── Nested archives ───────────────────────────────────────────────────────
  if (arc > 30) return {
    decision:   'nested_archives',
    pipeline:   ['extract_recurse', 'server_sort'],
    confidence: 0.80,
    reason:     `${Math.round(arc)}% archives inside — needs recursive extraction on server`,
    needsPhi:   false,
  };

  // ── Genuinely mixed — hand to Phi ─────────────────────────────────────────
  return {
    decision:   null,
    pipeline:   null,
    confidence: 0.0,
    reason:     `Mixed: img=${Math.round(img)}% vid=${Math.round(vid)}% doc=${Math.round(doc)}% aud=${Math.round(aud)}% code=${Math.round(code)}%`,
    needsPhi:   true,
  };
}

function pipelineFor(type) {
  const map = {
    google_photos:  ['czkawka', 'immich_import'],
    old_memories:   ['czkawka', 'exiftool_pass', 'immich_import', 'esrgan_eligible'],
    google_drive:   ['nc_sync', 'archive'],
    onedrive:       ['nc_sync', 'archive'],
    documents:      ['nc_sync'],
    audio:          ['archive_audio'],
    code:           ['git_detect', 'archive_code'],
    media_projects: ['archive_only'],
    general_backup: ['server_sort'],
  };
  return map[type] || ['server_sort'];
}

// ─── Tier 2: Phi-4-mini ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the VVC onboard assistant running on the user's laptop.
Your job is to help migrate personal files to a home server (VVC).
You have access to tools that inspect the user's filesystem.
Always respond in plain, friendly English. Be brief — one or two sentences max.
Never show raw JSON or technical details to the user.
When you have enough information, make a clear recommendation.
Ask at most one clarifying question at a time.`;

// Tools exposed to Phi via OpenAI function calling format
const PHI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'enumerate_drives',
      description: 'List all drives and volumes on the laptop with free space',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List contents of a directory — files and subfolders with sizes',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path to directory' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'peek_archive',
      description: 'Sample up to 500 file headers inside a tar/zip archive and return MIME distribution',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path to archive file' } },
        required: ['path'],
      },
    },
  },
];

/**
 * Ask Phi what to do with a source.
 * toolHandler: async (toolName, args) => result object
 * onToken: (text) => void  — streaming text to UI
 */
export async function phiDecide(source, toolHandler, onToken) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildUserContext(source),
    },
  ];

  // agentic loop — Phi may call multiple tools before answering
  for (let turn = 0; turn < 6; turn++) {
    const res = await callPhi(messages, turn < 5 ? PHI_TOOLS : []); // no tools on last turn

    if (res.finish_reason === 'tool_calls') {
      // execute each tool call
      const toolResults = [];
      for (const call of res.message.tool_calls || []) {
        const args   = JSON.parse(call.function.arguments || '{}');
        const result = await toolHandler(call.function.name, args);
        toolResults.push({
          role:         'tool',
          tool_call_id: call.id,
          content:      JSON.stringify(result),
        });
      }
      messages.push(res.message);          // assistant message with tool_calls
      messages.push(...toolResults);       // tool results
      continue;
    }

    // final answer — stream tokens to UI
    const text = res.message?.content || '';
    onToken?.(text);

    // extract structured decision from Phi's reasoning if possible
    return {
      decision:   extractDecision(text),
      pipeline:   null,     // server decides pipeline from decision
      confidence: 0.80,
      reason:     text,
      needsPhi:   false,
      phiAnswer:  text,
    };
  }

  // exceeded turns — fallback
  return {
    decision:   'general_backup',
    pipeline:   ['server_sort'],
    confidence: 0.50,
    reason:     'Could not determine — server will sort by MIME type',
    needsPhi:   false,
  };
}

function buildUserContext(source) {
  const parts = [`I have a source at: ${source.path}`];
  if (source.entryType === 'tarball') parts.push(`It is an archive file (${source.path.split('.').pop().toUpperCase()}).`);
  if (source.mimeDistribution) {
    const d = source.mimeDistribution;
    const items = Object.entries(d).map(([k,v]) => `${k}: ${Math.round(v*100)}%`).join(', ');
    parts.push(`Sampled ${source.sampledFiles || 'some'} files inside. MIME breakdown: ${items}.`);
  }
  if (source.hasJsonSidecars) parts.push('Found JSON sidecar files (may be Google Photos metadata).');
  if (source.userType) parts.push(`I think this might be: ${source.userType}.`);
  parts.push('What should I do with this? Where should it go on my home server?');
  return parts.join(' ');
}

function extractDecision(text) {
  const lower = text.toLowerCase();
  if (lower.includes('google photos') || lower.includes('immich'))  return 'google_photos';
  if (lower.includes('old memor') || lower.includes('old photo'))   return 'old_memories';
  if (lower.includes('google drive'))                                return 'google_drive';
  if (lower.includes('onedrive'))                                    return 'onedrive';
  if (lower.includes('music') || lower.includes('audio'))           return 'audio';
  if (lower.includes('code') || lower.includes('repositor'))        return 'code';
  if (lower.includes('document') || lower.includes('nextcloud'))    return 'documents';
  if (lower.includes('media project') || lower.includes('footage')) return 'media_projects';
  return 'general_backup';
}

// ─── Phi HTTP call ────────────────────────────────────────────────────────────

async function callPhi(messages, tools = []) {
  const body = {
    model:       'phi-4-mini',    // llama-server uses model name from loaded file
    messages,
    temperature: 0.2,             // low temp — deterministic decisions
    max_tokens:  512,
    stream:      false,
  };
  if (tools.length > 0) {
    body.tools       = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(PHI_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Phi call failed: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0] || {};
}

// ─── Plain English answers for UI events ─────────────────────────────────────
// These cover common events without calling Phi — instant responses

export async function explainEvent(event, context, onToken) {
  // For well-understood events, return instantly without LLM
  const instant = instantExplain(event, context);
  if (instant) { onToken?.(instant); return instant; }

  // For complex events, ask Phi
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: buildEventPrompt(event, context) },
  ];
  const res  = await callPhi(messages, []);
  const text = res.message?.content || '';
  onToken?.(text);
  return text;
}

function instantExplain(event, ctx) {
  switch (event) {

    case 'rsync_start':
      return `Starting transfer of ${ctx.sourceName}. Watch progress below.`;

    case 'rsync_progress':
      if (ctx.pct !== undefined)
        return `Transferring ${ctx.sourceName} — ${ctx.pct}% done.${ctx.eta ? ` About ${ctx.eta} remaining.` : ''}`;
      return null;

    case 'rsync_done':
      return ctx.ok
        ? `✅ ${ctx.sourceName} transferred successfully.`
        : `❌ Transfer failed for ${ctx.sourceName}. Safe to retry — rsync picks up where it left off.`;

    case 'rsync_error_connection_reset':
      return `Network hiccup during transfer. Safe to retry — rsync picks up where it left off.`;

    case 'rsync_error_no_space':
      return `Destination is full. Free up space on VVC before retrying.`;

    case 'rsync_error_permission':
      return `Permission denied on VVC. Check that your SSH user has write access to the destination.`;

    case 'peek_done':
      return formatPeekSummary(ctx.peekResult);

    case 'survey_uploaded':
      return `Plan sent to VVC. Check Telegram — your server will start processing.`;

    case 'phi_loading':
      return `Starting AI assistant (${ctx.gpu || 'CPU'})…`;

    case 'phi_ready':
      return `AI assistant ready on ${ctx.gpu}.`;

    case 'phi_unavailable':
      return `Running in basic mode — AI assistant not available. All decisions are rule-based.`;

    case 'model_downloading':
      return `Downloading Phi-4-mini (${ctx.pct || 0}% of ${MODEL_SIZE_GB} GB)…`;

    default:
      return null;
  }
}

function formatPeekSummary(result) {
  if (!result?.mimeDistribution) return 'Could not read archive contents.';
  const d    = result.mimeDistribution;
  const top  = Object.entries(d).sort((a,b) => b[1]-a[1]).slice(0, 3);
  const desc = top.map(([k,v]) => `${Math.round(v*100)}% ${k}`).join(', ');
  const suff = result.hasJsonSidecars ? ' Google Photos metadata detected.' : '';
  return `Inside: ${desc} (sampled ${result.sampledFiles} files).${suff}`;
}

function buildEventPrompt(event, ctx) {
  return `Event: ${event}\nContext: ${JSON.stringify(ctx)}\nExplain what happened in one plain sentence.`;
}

// re-export for external use
export const MODEL_SIZE_GB = 2.1;

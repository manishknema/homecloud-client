#!/usr/bin/env bun
/**
 * test-decision-engine.js — unit tests for decision-engine.js
 * Run: bun test scripts/onboard/test/test-decision-engine.js
 */

import { describe, test, expect } from 'bun:test';
import { ruleDecide } from '../decision-engine.js';

// ─── ruleDecide ───────────────────────────────────────────────────────────────

describe('ruleDecide — google_photos', () => {
  test('JSON sidecars + 80% media → google_photos confidence 0.95', () => {
    const r = ruleDecide({
      mimeDistribution: { image: 0.70, video: 0.10, document: 0.10, other: 0.10 },
      hasJsonSidecars: true,
    });
    expect(r.decision).toBe('google_photos');
    expect(r.confidence).toBeGreaterThanOrEqual(0.90);
    expect(r.needsPhi).toBe(false);
    expect(r.pipeline).toContain('immich_import');
  });

  test('JSON sidecars but only 50% media → NOT google_photos', () => {
    const r = ruleDecide({
      mimeDistribution: { image: 0.30, video: 0.20, document: 0.50 },
      hasJsonSidecars: true,
    });
    // media = 50% < 60% threshold → should NOT be google_photos
    expect(r.decision).not.toBe('google_photos');
  });
});

describe('ruleDecide — old_memories', () => {
  test('75% photos/videos without sidecars → old_memories', () => {
    const r = ruleDecide({
      mimeDistribution: { image: 0.60, video: 0.15, document: 0.25 },
      hasJsonSidecars: false,
    });
    expect(r.decision).toBe('old_memories');
    expect(r.pipeline).toContain('immich_import');
    expect(r.pipeline).toContain('esrgan_eligible');
    expect(r.needsPhi).toBe(false);
  });

  test('exactly 70% media → old_memories (boundary)', () => {
    const r = ruleDecide({
      mimeDistribution: { image: 0.70, document: 0.30 },
      hasJsonSidecars: false,
    });
    expect(r.decision).toBe('old_memories');
  });
});

describe('ruleDecide — audio', () => {
  test('95% audio → audio decision', () => {
    const r = ruleDecide({
      mimeDistribution: { audio: 0.95, other: 0.05 },
    });
    expect(r.decision).toBe('audio');
    expect(r.pipeline).toContain('archive_audio');
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

describe('ruleDecide — code', () => {
  test('80% code files → code decision', () => {
    const r = ruleDecide({
      mimeDistribution: { code: 0.80, document: 0.20 },
    });
    expect(r.decision).toBe('code');
    expect(r.pipeline).toContain('git_detect');
    expect(r.pipeline).toContain('archive_code');
  });
});

describe('ruleDecide — documents', () => {
  test('90% documents → documents decision', () => {
    const r = ruleDecide({
      mimeDistribution: { document: 0.90, other: 0.10 },
    });
    expect(r.decision).toBe('documents');
    expect(r.pipeline).toContain('nc_sync');
  });
});

describe('ruleDecide — nested_archives', () => {
  test('40% archives → nested_archives', () => {
    const r = ruleDecide({
      mimeDistribution: { archive: 0.40, document: 0.30, image: 0.30 },
    });
    expect(r.decision).toBe('nested_archives');
    expect(r.pipeline).toContain('extract_recurse');
  });
});

describe('ruleDecide — userType override', () => {
  test('userType + 25% media → use userType', () => {
    const r = ruleDecide({
      mimeDistribution: { image: 0.15, video: 0.10, document: 0.75 },
      userType: 'google_drive',
    });
    expect(r.decision).toBe('google_drive');
    expect(r.confidence).toBeGreaterThanOrEqual(0.70);
  });
});

describe('ruleDecide — mixed → Phi', () => {
  test('genuinely mixed content → needsPhi true', () => {
    const r = ruleDecide({
      mimeDistribution: { image: 0.25, document: 0.25, code: 0.25, audio: 0.25 },
      hasJsonSidecars: false,
    });
    expect(r.needsPhi).toBe(true);
    expect(r.decision).toBeNull();
    expect(r.pipeline).toBeNull();
    expect(r.confidence).toBe(0.0);
  });

  test('empty distribution → needsPhi true', () => {
    const r = ruleDecide({ mimeDistribution: {} });
    expect(r.needsPhi).toBe(true);
  });
});

describe('ruleDecide — priority order', () => {
  test('google_photos takes priority over old_memories even without sidecars if media > 70%', () => {
    // With sidecars AND high media → google_photos wins
    const r = ruleDecide({
      mimeDistribution: { image: 0.80, video: 0.10, other: 0.10 },
      hasJsonSidecars: true,
    });
    expect(r.decision).toBe('google_photos');
  });
});

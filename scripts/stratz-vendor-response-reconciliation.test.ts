import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonSha256 } from './stratz-matchup-root-cause-research.mjs';
import {
  FIX17_PATHS,
  PRODUCTION_CHANGES_AFTER_FIX16,
  QUESTIONS,
  analyzeResponse,
  buildFix17,
  compareManifests,
  hashSource,
  initialStatusRecord,
  resolveRootCause,
  responseTemplate,
  runCheck,
  securityFindings,
  transitionEscalation,
  validateContent,
  validateResponse,
  validateStatusRecord,
  verifyRecordedReferences,
} from './stratz-vendor-response-reconciliation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const build = buildFix17();
const { markdown, truths, facts, evidence } = build;
const ctx = { truths, facts, buckets: [2963, 2964, 2965, 2966] };
const mismatchClaims = (md: string) => validateContent(md, ctx).mismatches.map((m: any) => m.claim);
const PASS = { content: 'PASS', hashes: 'PASS', security: 'CLEAN' };
const human = { confirmedBy: 'Daniil', humanConfirmed: true };
const sentPayload = { ...human, sentAt: '2026-11-14T10:00:00Z', ticketReference: 'TICKET-1', submissionChannel: 'support form' };
const ready = () => transitionEscalation(initialStatusRecord(), 'READY_FOR_SUBMISSION', {}, { validation: PASS });
const sent = () => transitionEscalation(ready(), 'SENT', sentPayload);

// Test fixture only (not a STRATZ answer).
const FIXTURE_TEXT = 'Thanks for the report. The matchUp aggregate is computed per player, so bracketBasicIds applies to the rank of each player.\n\nCounts for A vs B and B vs A are not always equal because of this.\n\nMatch IDs are not exposed for aggregates.';
const received = (extra: any = {}) => ({
  ...responseTemplate(), inputStatus: 'RECEIVED', ticketReference: 'TICKET-1', receivedAt: '2026-11-20T09:00:00Z',
  sender: 'STRATZ support', source: 'support e-mail', originalResponse: FIXTURE_TEXT, responseSha256: sha(FIXTURE_TEXT), ...extra,
});
const tamperedRead = (relative: string, transform: (text: string) => string) => (file: string, encoding?: any) => {
  const original = readFileSync(file);
  if (path.resolve(file) !== path.join(ROOT, relative)) return encoding ? original.toString(encoding) : original;
  const changed = Buffer.from(transform(original.toString('utf8')));
  return encoding ? changed.toString(encoding) : changed;
};

describe('numerical validation', () => {
  it('1. exact A→B / B→A values agree across all historical observations', () => {
    const [enc, sd] = truths;
    expect(enc.total).toMatchObject({ AtoB: 1318, BtoA: 1361, delta: -43 });
    expect(sd.total).toMatchObject({ AtoB: 1182, BtoA: 1137, delta: 45 });
    expect(enc.pair.heroA.id).toBe(58);
    expect(sd.pair.heroA.id).toBe(61);
    for (const t of truths) {
      expect(t.disagreements).toEqual([]);
      expect(t.observationSources.length).toBeGreaterThanOrEqual(10);
      expect(t.observationSources).toEqual(expect.arrayContaining(['FIX9 batch (raw)', 'FIX10 pass 1 (raw)', 'FIX10 pass 2 (raw)', 'FIX12 production filter (raw)', 'FIX13 per-week rows (sum)']));
      expect(Object.values(t.perBucket).flatMap((v: any) => [v.AtoB, v.BtoA]).every(Number.isInteger)).toBe(true);
    }
    expect(markdown).toContain('| Enchantress (58) / Broodmother (61) | 1318 | 1361 | −43 |');
    expect(markdown).toContain('| Broodmother (61) / Shadow Demon (79) | 1182 | 1137 | +45 |');
    expect(evidence.contentValidation).toMatchObject({ status: 'PASS', mismatches: [] });
  });

  it('2. an invalid numerical claim is detected', () => {
    expect(mismatchClaims(markdown.replace('| 1318 | 1361 |', '| 1319 | 1361 |'))).toContain('totals 58:61 (orientation A=58)');
    expect(mismatchClaims(markdown.replace('in 446/446 checked rows', 'in 445/446 checked rows'))).toContain('winsAverage');
    expect(mismatchClaims(markdown.replace('take: 200) { heroId vs', 'take: 100) { heroId vs'))).toContain('query text hash');
    // Swapped orientation is a mismatch too.
    expect(mismatchClaims(markdown.replace('| Enchantress (58) / Broodmother (61) | 1318 | 1361 | −43 |', '| Enchantress (58) / Broodmother (61) | 1361 | 1318 | +43 |'))).toContain('totals 58:61 (orientation A=58)');
  });

  it('3. a wrong bucket aggregation is detected', () => {
    const md = markdown.replace('| 301 / 318 |', '| 300 / 318 |');
    expect(mismatchClaims(md)).toEqual(expect.arrayContaining(['weekly 58:61', 'bucket aggregation 58:61']));
    expect(mismatchClaims(markdown.replace('| week 2963 | week 2964 |', '| week 2964 | week 2963 |'))).toContain('week columns');
  });

  it('4. a wrong bracket description is detected', () => {
    expect(mismatchClaims(markdown.replace('`bracketBasicIds`: `HERALD_GUARDIAN`, ', '`bracketBasicIds`: '))).toContain('production brackets (configuration)');
    expect(mismatchClaims(markdown.replace('- `HERALD_GUARDIAN`: 95 / 96', '- `UNCALIBRATED`: 95 / 96'))).toContain('bracket breakdown 58:61');
    expect(mismatchClaims(markdown.replace('- `CRUSADER_ARCHON`: 100 / 105', '- `CRUSADER_ARCHON`: 100 / 104'))).toEqual(expect.arrayContaining(['bracket breakdown 58:61', 'bracket sum 58:61']));
  });
});

describe('OpenDota caveat', () => {
  it('5. the OpenDota ratio caveat sentence is required', () => {
    expect(markdown).toContain('In our independent OpenDota reference sample, STRATZ directional match counts ranged from approximately 0.33 to 0.55 of the corresponding external pair-match counts. This is not a coverage estimate because the two sources do not expose equivalent match eligibility, rank, and completeness filters.');
    const without = markdown.replace(/In our independent OpenDota reference sample[^\n]+\n/, '');
    expect(mismatchClaims(without)).toContain('OpenDota caveat sentence');
  });

  it('6. the OpenDota comparison is never classified as coverage', () => {
    for (const bad of ['STRATZ loses 45–67% of matches.', 'STRATZ covers only 33–55% of matches.', 'OpenDota proved a STRATZ error.', "STRATZ's coverage is 45%."]) {
      expect(mismatchClaims(`${markdown}\n${bad}\n`)).toContain('forbidden OpenDota phrasing');
    }
    expect(evidence.openDotaComparison.classification).toBe('REFERENCE_RATIO_NOT_COVERAGE_ESTIMATE');
    expect(evidence.openDotaComparison.externalCoverage).toBe('PARTIAL_MATCH_COVERAGE');
  });
});

describe('hashes', () => {
  it('7. a source SHA mismatch is detected', () => {
    const tampered = buildFix17({ read: tamperedRead('research/data-quality/stratz-opendota-coverage-validation-raw-responses.json', (t) => `${t} `) as any });
    expect(tampered.evidence.hashValidation.status).toBe('FAIL');
    expect(tampered.evidence.hashValidation.mismatches.map((m: any) => m.check)).toContain('FIX16 inputs.fix16Raw');
    expect(compareManifests(build.manifest, tampered.manifest).map((m: any) => m.path)).toContain('research/data-quality/stratz-opendota-coverage-validation-raw-responses.json');
    expect(verifyRecordedReferences().every((c: any) => c.status !== 'MISMATCH')).toBe(true);
  });

  it('8. a canonical hash mismatch is detected', () => {
    const relative = 'research/data-quality/stratz-reverse-pair-match-level-evidence.json';
    expect(hashSource(relative).canonicalStatus).toBe('MATCH');
    const read = tamperedRead(relative, (t) => t.replace('"typeCount": 513', '"typeCount": 514'));
    expect(hashSource(relative, read as any).canonicalStatus).toBe('MISMATCH');
    // A cross-reference hash (FIX10 report → FIX9 input) is not treated as a self-hash.
    const report = hashSource('research/data-quality/stratz-reverse-pair-asymmetry-report.json');
    expect(report).toMatchObject({ canonicalStatus: 'NOT_DEFINED', crossReference: { field: 'inputSha256' } });
  });
});

describe('security', () => {
  it('9. credentials are detected', () => {
    expect(securityFindings('Authorization: Bearer abcdefghijklmnopqrstuvwxyz').map((f: any) => f.kind).length).toBeGreaterThan(0);
    expect(securityFindings('value=supersecretvalue123', { knownSecrets: ['supersecretvalue123'] }).map((f: any) => f.kind)).toContain('KNOWN_SECRET_VALUE');
    expect(securityFindings('STRATZ_API_TOKEN=abc12345').map((f: any) => f.kind)).toContain('ENV_ASSIGNMENT');
    expect(securityFindings('contact someone@example.com').map((f: any) => f.kind)).toContain('EMAIL_ADDRESS');
    expect(evidence.securityValidation).toMatchObject({ status: 'CLEAN', findings: [] });
  });

  it('10. IP headers and addresses are excluded', () => {
    const kinds = securityFindings('x-ip-address: 203.0.113.7').map((f: any) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['IP_HEADER', 'IP_ADDRESS']));
    expect(securityFindings('x-forwarded-for', { strict: false }).map((f: any) => f.kind)).toContain('IP_HEADER');
    expect(securityFindings('patch 7.41, ratio 0.33').length).toBe(0);
    expect(evidence.securityValidation.scanned).toEqual(expect.arrayContaining(['research/data-quality/stratz-external-match-level-raw-responses.json', 'research/data-quality/stratz-opendota-coverage-validation-raw-responses.json']));
    expect(JSON.stringify(build.manifest)).not.toMatch(/x-ip-address|x-forwarded-for/i);
  });
});

describe('escalation status', () => {
  it('11. status is DRAFTED and generation does not change it', () => {
    expect(evidence.escalationStatus).toBe('DRAFTED');
    expect(evidence.submission).toMatchObject({ sent: false, ticketReference: null });
    expect(JSON.parse(readFileSync(path.join(ROOT, FIX17_PATHS.status), 'utf8')).status).toBe('DRAFTED');
    expect(markdown).not.toMatch(/DRAFTED|READY_FOR_SUBMISSION|\bSENT\b/);
    const readyRecord = ready();
    expect(buildFix17({ statusRecord: readyRecord }).evidence.escalationStatus).toBe('READY_FOR_SUBMISSION');
  });

  it('12. DRAFTED → READY_FOR_SUBMISSION only after content, hash and security validation', () => {
    expect(ready().status).toBe('READY_FOR_SUBMISSION');
    expect(() => transitionEscalation(initialStatusRecord(), 'READY_FOR_SUBMISSION', {}, { validation: { ...PASS, content: 'FAIL' } })).toThrow(/validation/);
    expect(() => transitionEscalation(initialStatusRecord(), 'READY_FOR_SUBMISSION', {}, {})).toThrow(/validation/);
    expect(evidence.readyForSubmissionEligible).toBe(true);
  });

  it('13. SENT without human confirmation is rejected', () => {
    expect(() => transitionEscalation(initialStatusRecord(), 'SENT', sentPayload)).toThrow(/not allowed/);
    expect(() => transitionEscalation(ready(), 'SENT', { ...sentPayload, humanConfirmed: false })).toThrow(/human/);
    expect(() => transitionEscalation(ready(), 'SENT', { ...sentPayload, confirmedBy: 'generator' })).toThrow(/human/);
    expect(() => transitionEscalation(ready(), 'SENT', { ...sentPayload, confirmedBy: 'Claude' })).toThrow(/human/);
    for (const field of ['ticketReference', 'submissionChannel', 'sentAt']) {
      expect(() => transitionEscalation(ready(), 'SENT', { ...sentPayload, [field]: '' })).toThrow(new RegExp(field));
    }
  });

  it('14. SENT with explicit human confirmation is accepted', () => {
    const record = sent();
    expect(record.status).toBe('SENT');
    expect(record.submission).toEqual({ sent: true, ticketReference: 'TICKET-1', submissionChannel: 'support form', sentAt: '2026-11-14T10:00:00Z', confirmedBy: 'Daniil' });
    expect(validateStatusRecord(record).status).toBe('VALID');
    expect(validateStatusRecord({ ...record, submission: { sent: false } }).status).toBe('INVALID');
  });

  it('15. ACKNOWLEDGED requires acknowledgement and reference', () => {
    expect(() => transitionEscalation(sent(), 'ACKNOWLEDGED', { confirmedBy: 'Daniil', acknowledgedAt: '2026-11-15T00:00:00Z', acknowledgement: 'auto-reply' })).toThrow(/reference/);
    expect(() => transitionEscalation(sent(), 'ACKNOWLEDGED', { confirmedBy: 'Daniil', acknowledgedAt: '2026-11-15T00:00:00Z', reference: 'TICKET-1' })).toThrow(/acknowledgement/);
    const ack = transitionEscalation(sent(), 'ACKNOWLEDGED', { confirmedBy: 'Daniil', acknowledgedAt: '2026-11-15T00:00:00Z', acknowledgement: 'received', reference: 'TICKET-1' });
    expect(ack.status).toBe('ACKNOWLEDGED');
    expect(() => transitionEscalation(ack, 'ANSWERED', { confirmedBy: 'Daniil', response: responseTemplate() })).toThrow(/received response/);
    expect(transitionEscalation(ack, 'ANSWERED', { confirmedBy: 'Daniil', response: received() }).status).toBe('ANSWERED');
  });
});

describe('vendor response intake', () => {
  it('16. a missing response stays NOT_RECEIVED and is never fabricated', () => {
    const saved = JSON.parse(readFileSync(path.join(ROOT, FIX17_PATHS.response), 'utf8'));
    expect(saved).toEqual(responseTemplate());
    expect(validateResponse(saved).status).toBe('NOT_RECEIVED');
    expect(evidence.vendorResponse).toMatchObject({ status: 'NOT_RECEIVED', claims: [] });
    expect(evidence.vendorResponse.questions.every((q: any) => q.answerStatus === 'NOT_ANSWERED')).toBe(true);
    expect(validateResponse({ ...responseTemplate(), originalResponse: 'something' }).status).toBe('INVALID');
  });

  it('17. a valid official response is split into claims mapped to questions', () => {
    const analysis = analyzeResponse(received(), facts);
    expect(analysis.status).toBe('RECEIVED');
    expect(analysis.claims.length).toBeGreaterThanOrEqual(3);
    for (const claim of analysis.claims) {
      expect(FIXTURE_TEXT).toContain(claim.originalText);
      expect(Object.keys(claim)).toEqual(expect.arrayContaining(['claimId', 'originalText', 'questionId', 'answerStatus', 'supportingEvidence', 'contradictingEvidence', 'sourceReference', 'confidence', 'remainingQuestions']));
    }
    const perPlayer = analysis.claims.find((c: any) => /per player/.test(c.originalText));
    expect(perPlayer.relatedQuestionIds).toContain('Q5');
    expect(perPlayer.historicalChecks.map((c: any) => c.checkId)).toContain('BRACKET_CONDITION_CLAIM');
    expect(perPlayer.historicalChecks.find((c: any) => c.checkId === 'BRACKET_CONDITION_CLAIM').verifiableWithoutNewMatchLevelData).toBe('PARTIAL');
    expect(analysis.questions).toHaveLength(QUESTIONS.length);
    expect(analysis.questions.find((q: any) => q.questionId === 'Q9').answerStatus).toBe('NOT_ANSWERED');
  });

  it('18. an empty response is rejected', () => {
    for (const text of ['', '   \n ']) {
      const result = validateResponse(received({ originalResponse: text, responseSha256: sha(text) }));
      expect(result.status).toBe('INVALID');
      expect(result.errors).toContain('originalResponse is empty');
    }
    expect(validateResponse(received({ sender: null, source: null })).errors).toContain('sender or source is required');
    expect(validateResponse(received({ ticketReference: null })).errors).toContain('ticketReference is required');
  });

  it('19. an ambiguous vendor claim stays AMBIGUOUS without a human annotation', () => {
    const analysis = analyzeResponse(received(), facts);
    expect(analysis.claims.every((c: any) => c.answerStatus === 'AMBIGUOUS' && c.confidence === 'LOW')).toBe(true);
    const bot = received({ reviewerAnnotations: [{ annotatedBy: 'claude', quote: 'computed per player', answerStatus: 'CONFIRMED_BY_VENDOR', questionId: 'Q5' }] });
    expect(validateResponse(bot).status).toBe('INVALID');
    const invented = received({ reviewerAnnotations: [{ annotatedBy: 'Daniil', quote: 'counts are symmetric by contract', answerStatus: 'CONFIRMED_BY_VENDOR', questionId: 'Q1' }] });
    expect(validateResponse(invented).errors.join(' ')).toMatch(/verbatim/);
    const ok = received({ reviewerAnnotations: [{ annotatedBy: 'Daniil', quote: 'computed per player', answerStatus: 'CONFIRMED_BY_VENDOR', questionId: 'Q5', confidence: 'HIGH' }] });
    const annotated = analyzeResponse(ok, facts).claims.find((c: any) => /per player/.test(c.originalText));
    expect(annotated).toMatchObject({ answerStatus: 'CONFIRMED_BY_VENDOR', confidence: 'HIGH' });
    expect(annotated.statusSource).toMatch(/reviewer annotation by Daniil/);
  });

  it('20. the root cause is not resolved automatically', () => {
    expect(evidence.rootCause).toMatchObject({ status: 'UNRESOLVED', productionPublishAllowed: false, matchLevelReconciliation: 'NOT_PERFORMED' });
    const annotated = received({ reviewerAnnotations: [
      { annotatedBy: 'Daniil', quote: 'computed per player', answerStatus: 'CONFIRMED_BY_VENDOR', questionId: 'Q5' },
      { annotatedBy: 'Daniil', quote: 'not always equal because of this', answerStatus: 'CONFIRMED_BY_VENDOR', questionId: 'Q4' },
    ] });
    const analysis = analyzeResponse(annotated, facts);
    expect(resolveRootCause(analysis).status).toBe('PARTIALLY_EXPLAINED');
    const q4 = analysis.claims.find((c: any) => c.questionId === 'Q4');
    const base = { status: 'STRATZ_FIELD_SEMANTICS_CONFIRMED', vendorClaimIds: [q4.claimId], decidedBy: 'Daniil', evidence: ['fix13Evidence'] };
    expect(resolveRootCause(analysis, { ...base, reproducedOnHistoricalEvidence: false }).status).toBe('PARTIALLY_EXPLAINED');
    expect(resolveRootCause(analysis, { ...base, reproducedOnHistoricalEvidence: true, decidedBy: 'generator' }).status).toBe('PARTIALLY_EXPLAINED');
    const resolved = resolveRootCause(analysis, { ...base, reproducedOnHistoricalEvidence: true });
    expect(resolved.status).toBe('STRATZ_FIELD_SEMANTICS_CONFIRMED');
    expect(resolved.productionPublishAllowed).toBe(false);
    expect(resolved.matchLevelReconciliation).toBe('NOT_PERFORMED');
    expect(resolveRootCause(analyzeResponse(received(), facts)).status).toBe('UNRESOLVED');
  });

  it('21. the response hash and attachment hashes are validated', () => {
    expect(validateResponse(received()).status).toBe('RECEIVED');
    expect(validateResponse(received({ responseSha256: sha('other') })).errors).toContain('responseSha256 does not match sha256(originalResponse)');
    const target = 'research/data-quality/stratz-support-escalation-v2.md';
    const good = { name: 'v2', path: target, sha256: sha(readFileSync(path.join(ROOT, target))) };
    expect(validateResponse(received({ attachments: [good] })).status).toBe('RECEIVED');
    expect(validateResponse(received({ attachments: [{ ...good, sha256: sha('x') }] })).status).toBe('INVALID');
    expect(validateResponse(received({ attachments: [{ name: 'x' }] })).status).toBe('INVALID');
  });
});

describe('determinism and protection', () => {
  it('22. report generation is deterministic, offline and reproduces the saved artifacts', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const again = buildFix17();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(again.outputs).toEqual(build.outputs);
    expect(canonicalJsonSha256(evidence, 'evidenceSha256')).toBe(evidence.evidenceSha256);
    const report = runCheck();
    expect(report).toMatchObject({ ok: true, failures: [], escalationStatus: 'DRAFTED', vendorResponse: 'NOT_RECEIVED', rootCause: 'UNRESOLVED' });
  });

  it('FIX9–FIX16 and production hashes are unchanged (against hashes recorded by FIX16 and the FIX17 manifest)', () => {
    const fix16 = JSON.parse(readFileSync(path.join(ROOT, 'research/data-quality/stratz-opendota-coverage-validation-evidence.json'), 'utf8'));
    const changed = new Set(Object.keys(PRODUCTION_CHANGES_AFTER_FIX16));
    for (const entry of Object.values(fix16.protectedHashes) as any[]) {
      if (changed.has(entry.path)) continue; // retired / re-pinned by ТЗ №77, reported separately
      expect(sha(readFileSync(path.join(ROOT, entry.path)))).toBe(entry.physicalSha256);
    }
    expect(evidence.hashValidation.productionChangedAfterFix16.map((c: any) => [c.path, c.status]).sort()).toEqual([
      ['public/data/item-stats.json', 'RETIRED_BY_TZ77'], ['public/data/items.json', 'RETIRED_BY_TZ77'], ['scripts/update-data-stratz.mjs', 'CHANGED_BY_TZ77'],
    ]);
    // Research evidence references (FIX9–FIX16) still match exactly.
    expect(verifyRecordedReferences().filter((c: any) => !changed.has(c.path)).every((c: any) => c.status === 'MATCH')).toBe(true);
    const saved = JSON.parse(readFileSync(path.join(ROOT, FIX17_PATHS.manifest), 'utf8'));
    expect(compareManifests(saved, build.manifest)).toEqual([]);
    expect(saved.production.map((p: any) => p.path)).toEqual(expect.arrayContaining(['public/data/heroes.json', 'public/data/matchups.json', 'public/data/meta.json', 'scripts/update-data-stratz.mjs']));
  });
});

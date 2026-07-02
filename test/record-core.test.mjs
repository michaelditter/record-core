// record-core test suite. Real Schnorr crypto via nostr-tools; no network needed
// (the live relay roundtrip is opt-in via RECORD_CORE_LIVE=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as NostrTools from 'nostr-tools';
import { randomBytes } from 'node:crypto';
import {
  CRP, townSlug, civicTags, buildRecord, buildCharter,
  signRecord, verifyRecord, recordLinks, anchorEventId, verifyAnchor
} from '../index.mjs';

test('townSlug normalizes to a queryable slug', () => {
  assert.equal(townSlug('Goshen', 'CT'), 'town-ct-goshen');
  assert.equal(townSlug('New Haven', 'CT'), 'town-ct-new-haven');
  assert.equal(townSlug('  Litchfield  ', 'ct'), 'town-ct-litchfield');
  assert.equal(townSlug('', ''), '');
});

test('civicTags requires a client and always carries the CRP tags', () => {
  assert.throws(() => civicTags({}), /client/);
  const t = civicTags({ client: 'the-record' });
  assert.ok(t.some((x) => x[0] === 'client' && x[1] === 'the-record'));
  assert.ok(t.some((x) => x[0] === 't' && x[1] === CRP.FAMILY_TAG));
  assert.ok(t.some((x) => x[0] === 't' && x[1] === CRP.RECORD_TAG));
});

test('civicTags rejects an unknown type', () => {
  assert.throws(() => civicTags({ client: 'x', type: 'not-a-type' }), /unknown type/);
});

test('buildRecord carries required tags + town scoping', () => {
  const tpl = buildRecord({
    content: 'On this date the assembly met.',
    client: 'the-record',
    type: 'minutes',
    town: { name: 'Goshen', state: 'CT', display: 'Goshen, CT' }
  });
  assert.equal(tpl.kind, CRP.KINDS.RECORD);
  const has = (k, v) => tpl.tags.some((x) => x[0] === k && x[1] === v);
  assert.ok(has('client', 'the-record'));
  assert.ok(has('t', 'youcannoteat'));
  assert.ok(has('t', 'civic-record'));
  assert.ok(has('t', 'minutes'));
  assert.ok(has('t', 'town-ct-goshen'), 'town slug tag present');
  assert.ok(tpl.tags.some((x) => x[0] === 'town' && x[1] === 'Goshen, CT'));
});

test('buildRecord rejects empty content', () => {
  assert.throws(() => buildRecord({ content: '  ', client: 'the-record' }), /content/);
});

test('sign + verify roundtrip (real schnorr, no network)', () => {
  const sk = NostrTools.generateSecretKey();
  const ev = signRecord(buildRecord({ content: 'put it on the record', client: 'the-record' }), sk, NostrTools);
  const v = verifyRecord(ev, NostrTools);
  assert.ok(v.valid, 'signature valid');
  assert.ok(v.crpCompliant, 'CRP compliant: ' + v.reasons.join(', '));
  const links = recordLinks(ev, NostrTools);
  assert.match(links.nevent, /^nevent1/);
  assert.match(links.npub, /^npub1/);
  assert.ok(links.njump.startsWith('https://njump.me/nevent1'));
});

test('verify rejects a tampered event', () => {
  const sk = NostrTools.generateSecretKey();
  const ev = signRecord(buildRecord({ content: 'original', client: 'the-record' }), sk, NostrTools);
  const forged = { ...ev, content: 'forged after signing' };
  assert.equal(verifyRecord(forged, NostrTools).valid, false);
});

test('verify flags a signature-valid but non-CRP event', () => {
  const sk = NostrTools.generateSecretKey();
  // a plain note with no CRP tags
  const ev = NostrTools.finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'hi' }, sk);
  const v = verifyRecord(ev, NostrTools);
  assert.ok(v.valid, 'signature is valid');
  assert.equal(v.crpCompliant, false);
  assert.ok(v.reasons.length > 0);
});

test('legacy therecord tag is accepted for CRP compliance', () => {
  const sk = NostrTools.generateSecretKey();
  const ev = NostrTools.finalizeEvent({
    kind: 1, created_at: Math.floor(Date.now() / 1000),
    tags: [['client', 'the-record'], ['t', 'youcannoteat'], ['t', 'therecord']],
    content: 'legacy record'
  }, sk);
  assert.ok(verifyRecord(ev, NostrTools).crpCompliant);
});

test('buildCharter is kind 30023 and requires a stable d', () => {
  assert.throws(() => buildCharter({ content: 'Article I', client: 'the-charter' }), /`d`/);
  const c = buildCharter({ content: 'Article I. The green is a commons.', title: 'Goshen Green', d: 'goshen-green', client: 'the-charter' });
  assert.equal(c.kind, CRP.KINDS.CHARTER);
  assert.ok(c.tags.some((x) => x[0] === 'd' && x[1] === 'goshen-green'));
  assert.ok(c.tags.some((x) => x[0] === 't' && x[1] === 'commons-charter'));
  assert.ok(c.tags.some((x) => x[0] === 'title' && x[1] === 'Goshen Green'));
});

// Opt-in live OpenTimestamps anchor: hits public calendar servers (network).
// OTS_LIVE=1 node --test   (skipped by default so the suite stays offline)
test('live: anchor a random 32-byte hash and confirm the proof commits to it',
  { skip: !process.env.OTS_LIVE }, async () => {
    const idHex = randomBytes(32).toString('hex');
    const { otsBase64, pending } = await anchorEventId(idHex);
    assert.equal(pending, true, 'a fresh proof is pending Bitcoin confirmation');
    assert.ok(otsBase64 && otsBase64.length > 0, 'got a serialized .ots proof');

    // The returned proof must deserialize and commit to exactly this id.
    const v = await verifyAnchor(idHex, otsBase64);
    assert.ok(v.ok, 'proof commits to the anchored id: ' + v.detail);

    // A proof for a *different* id must be rejected.
    const otherHex = randomBytes(32).toString('hex');
    const bad = await verifyAnchor(otherHex, otsBase64);
    assert.equal(bad.ok, false, 'proof must not verify against a different id');
  });

// Opt-in live roundtrip: actually publish to a relay and read it back.
// RECORD_CORE_LIVE=1 node --test   (needs network; skipped in CI by default)
test('live: publish + fetch back from a real relay', { skip: !process.env.RECORD_CORE_LIVE }, async () => {
  const { publishRecord } = await import('../index.mjs');
  const sk = NostrTools.generateSecretKey();
  const ev = signRecord(buildRecord({ content: 'record-core live test ' + Date.now(), client: 'record-core' }), sk, NostrTools);
  const report = await publishRecord(ev, ['wss://relay.damus.io', 'wss://nos.lol'], NostrTools);
  assert.ok(report.accepted >= 1, 'at least one relay accepted');
  const pool = new NostrTools.SimplePool();
  const got = await pool.get(['wss://relay.damus.io', 'wss://nos.lol'], { ids: [ev.id] });
  pool.close(['wss://relay.damus.io', 'wss://nos.lol']);
  assert.ok(got && got.id === ev.id, 'fetched the same event back');
  assert.ok(verifyRecord(got, NostrTools).valid);
});

// ============================================================
// record-core — the Civic Record Protocol (CRP) reference implementation.
//
// The canonical "build a civic record, sign it, publish it, verify it" logic,
// shared by the You Cannot Eat Code tool family (the-record, the-charter,
// the-mesh, and the youcannoteat.codes site) so a fix in one place is a fix in
// all of them, and every tool speaks the same on-wire grammar.
//
// Transport-agnostic and dependency-light: the pure builders need nothing, and
// signing / publishing / verifying take an INJECTED nostr-tools instance, so the
// identical code runs in Node (the CLIs) and in the browser (window.NostrTools).
//
// Spec: github.com/michaelditter/civic-record-protocol
// License: MIT
// ============================================================

export const CRP = Object.freeze({
  VERSION: '0.1',
  KINDS: Object.freeze({ RECORD: 1, CHARTER: 30023 }),
  FAMILY_TAG: 'youcannoteat',       // family umbrella hashtag (indexable via #t)
  RECORD_TAG: 'civic-record',       // marks a CRP civic record (neutral protocol tag)
  LEGACY_RECORD_TAG: 'therecord',   // accepted alias: pre-0.1 tools used this
  TYPES: Object.freeze(['commons-charter', 'mesh', 'minutes', 'notice', 'oath', 'witness']),
  DEFAULT_RELAYS: Object.freeze([
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://relay.nostr.band'
  ])
});

// ---- town scoping -------------------------------------------------
// A queryable town slug: "town-<state>-<name>", lowercased, non-alphanumerics
// collapsed to single dashes. townSlug('Goshen','CT') -> 'town-ct-goshen'.
// This is what makes "the town, not the platform" a real query: #t=town-ct-goshen
// returns a whole town's public record from any relay.
export function townSlug(name, state) {
  const norm = (x) =>
    String(x == null ? '' : x).toLowerCase().normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const parts = [norm(state), norm(name)].filter(Boolean);
  return parts.length ? 'town-' + parts.join('-') : '';
}

// Accept town as a slug string ('town-ct-goshen'), a bare name ('Goshen'),
// or an object { name, state, display }. Returns { slug, displayTag|null }.
function resolveTown(town) {
  if (!town) return { slug: '', displayTag: null };
  if (typeof town === 'string') {
    return { slug: town.startsWith('town-') ? town : townSlug(town), displayTag: null };
  }
  const slug = town.slug || townSlug(town.name, town.state);
  const displayTag = (town.display || town.name)
    ? ['town', String(town.display || town.name), String(town.state || '')]
    : null;
  return { slug, displayTag };
}

// ---- tag grammar --------------------------------------------------
// Build the CRP tag array. `client` (which tool wrote it) is required; the
// family + civic-record tags are always present; everything else is optional.
export function civicTags({ client, type, town, meshFrom, meshFromName, extra = [] } = {}) {
  if (!client) throw new Error('civicTags: `client` is required (the tool slug writing this record)');
  const tags = [
    ['client', String(client)],
    ['t', CRP.FAMILY_TAG],
    ['t', CRP.RECORD_TAG]
  ];
  if (type) {
    if (!CRP.TYPES.includes(type)) throw new Error(`civicTags: unknown type "${type}" (allowed: ${CRP.TYPES.join(', ')})`);
    tags.push(['t', type]);
  }
  const { slug, displayTag } = resolveTown(town);
  if (slug) tags.push(['t', slug]);
  if (displayTag) tags.push(displayTag);
  if (meshFrom != null) tags.push(['mesh_from', String(meshFrom)]);
  if (meshFromName) tags.push(['mesh_from_name', String(meshFromName)]);
  for (const t of extra) if (Array.isArray(t) && t.length) tags.push(t.map(String));
  return tags;
}

function nowSec() { return Math.floor(Date.now() / 1000); }

// ---- record + charter templates (unsigned) ------------------------
// A civic record: a kind-1 note carrying the CRP tags.
export function buildRecord({ content, client, type, town, meshFrom, meshFromName, extraTags = [], createdAt } = {}) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('buildRecord: `content` (a non-empty string) is required');
  }
  return {
    kind: CRP.KINDS.RECORD,
    created_at: createdAt || nowSec(),
    tags: civicTags({ client, type, town, meshFrom, meshFromName, extra: extraTags }),
    content
  };
}

// A commons charter: a kind-30023 (NIP-23) addressable, replaceable document.
// `d` (a stable identifier) is required — it is the address anchor. Because
// 30023 is replaceable by the keyholder, a *specific version* is referenced by
// its immutable event id (nevent); the *latest* by its address (naddr).
export function buildCharter({ content, title, summary, d, prev, client = 'the-charter', town, extraTags = [], createdAt } = {}) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('buildCharter: `content` is required');
  if (!d) throw new Error('buildCharter: `d` (a stable identifier) is required for a replaceable charter');
  const tags = civicTags({ client, type: 'commons-charter', town, extra: extraTags });
  tags.push(['d', String(d)]);
  if (title) tags.push(['title', String(title)]);
  if (summary) tags.push(['summary', String(summary)]);
  if (prev) tags.push(['prev', String(prev)]); // amendment chain: the version this replaces
  return {
    kind: CRP.KINDS.CHARTER,
    created_at: createdAt || nowSec(),
    tags,
    content
  };
}

// ---- sign / publish / links (inject nostr-tools) ------------------
export function signRecord(template, sk, NostrTools) {
  if (!NostrTools || typeof NostrTools.finalizeEvent !== 'function') {
    throw new Error('signRecord: pass a nostr-tools instance as the third argument');
  }
  return NostrTools.finalizeEvent(template, sk);
}

// Publish a signed event to several relays for durability. Resolves to a
// per-relay accept/fail report — never rejects, so a dead relay can't sink a
// publish that other relays accepted. Each relay is bounded by `timeoutMs`
// (default 8s) so one hung relay can't stall the whole call.
export async function publishRecord(event, relays, NostrTools, { timeoutMs = 8000 } = {}) {
  if (!NostrTools || typeof NostrTools.SimplePool !== 'function') {
    throw new Error('publishRecord: pass a nostr-tools instance as the third argument');
  }
  const list = (relays && relays.length ? relays : CRP.DEFAULT_RELAYS).slice();
  const pool = new NostrTools.SimplePool();
  const bounded = (p, relay) => Promise.race([
    Promise.resolve(p).then(() => ({ relay, ok: true, error: null })),
    new Promise((res) => setTimeout(() => res({ relay, ok: false, error: 'timeout' }), timeoutMs))
  ]).catch((e) => ({ relay, ok: false, error: String((e && e.message) || e) }));
  const per = await Promise.all(pool.publish(list, event).map((p, i) => bounded(p, list[i])));
  try { pool.close(list); } catch (e) { /* pool already closing */ }
  return { accepted: per.filter((p) => p.ok).length, total: list.length, per };
}

// Human-verifiable links for a signed event (njump + npub + nevent).
export function recordLinks(event, NostrTools, relays) {
  const nip19 = NostrTools.nip19;
  const nevent = nip19.neventEncode({
    id: event.id,
    author: event.pubkey,
    relays: (relays && relays.length ? relays : CRP.DEFAULT_RELAYS).slice(0, 2)
  });
  return { nevent, npub: nip19.npubEncode(event.pubkey), njump: 'https://njump.me/' + nevent };
}

// ---- verification (the CRP promise) -------------------------------
// A record is VALID iff its Schnorr signature verifies against its pubkey.
// It is additionally CRP-COMPLIANT iff it carries the required client + family
// + civic-record tags. The two are reported separately: an event can be
// signature-valid but not CRP-tagged (and vice versa is impossible to fake).
export function verifyRecord(event, NostrTools) {
  const reasons = [];
  if (!event || typeof event !== 'object') return { valid: false, crpCompliant: false, reasons: ['not an event object'] };

  // Rebuild a clean event from explicit fields only. nostr-tools caches its
  // verification result on the object via a Symbol; a caller (or attacker)
  // passing an object with a stale/forged cached flag must not be trusted, so we
  // strip everything but the canonical fields and re-verify from scratch.
  const clean = {
    id: event.id, pubkey: event.pubkey, created_at: event.created_at,
    kind: event.kind, tags: event.tags, content: event.content, sig: event.sig
  };
  let sigOk = false;
  try {
    // defense in depth: the id must be the hash of the (clean) event...
    if (typeof NostrTools.getEventHash === 'function' && NostrTools.getEventHash(clean) !== clean.id) {
      reasons.push('id does not match the event contents');
    }
    // ...and the signature must verify for that id/pubkey.
    sigOk = typeof NostrTools.verifyEvent === 'function' ? NostrTools.verifyEvent(clean) : false;
  } catch (e) { reasons.push('verifyEvent threw: ' + ((e && e.message) || e)); }
  if (!sigOk) reasons.push('signature or id is invalid');

  const tags = Array.isArray(event.tags) ? event.tags : [];
  const hasT = (v) => tags.some((t) => t[0] === 't' && t[1] === v);
  const tagReasons = [];
  if (!tags.some((t) => t[0] === 'client' && t[1])) tagReasons.push('missing required `client` tag');
  if (!hasT(CRP.FAMILY_TAG)) tagReasons.push(`missing family tag t=${CRP.FAMILY_TAG}`);
  if (!hasT(CRP.RECORD_TAG) && !hasT(CRP.LEGACY_RECORD_TAG)) {
    tagReasons.push(`missing record tag t=${CRP.RECORD_TAG} (or legacy t=${CRP.LEGACY_RECORD_TAG})`);
  }
  reasons.push(...tagReasons);
  return { valid: sigOk, crpCompliant: sigOk && tagReasons.length === 0, reasons };
}

// ---- OpenTimestamps anchoring (proof-of-existence) ----------------
// Nostr signatures prove *authorship* (this key wrote this). OpenTimestamps
// proves *existence in time* (this id existed by this moment), by committing a
// hash into the Bitcoin blockchain via free public calendar servers.
//
// CRITICAL: OTS anchors an ALREADY-SIGNED event id (a sha256). The .ots proof
// is created AFTER signing and CANNOT live inside the signed event — embedding
// it would change the id it commits to. The proof is stored and shared OUT OF
// BAND (a sidecar file, a URL). The CRP reserved `ots` tag is for out-of-band
// *references* to such a proof, never for the proof bytes themselves.
//
// Honesty: a fresh proof is PENDING. The calendar has promised to include the
// hash in a future Bitcoin block; that block takes hours to confirm. Only after
// upgrading and verifying against Bitcoin can we report a real block height and
// time. Never claim confirmation you do not have.

const OTS_INSTALL_HINT =
  'OpenTimestamps anchoring needs the optional `opentimestamps` package. Install it: npm i opentimestamps';

async function loadOTS() {
  try {
    const mod = await import('opentimestamps');
    return mod.default || mod;
  } catch (e) {
    throw new Error(OTS_INSTALL_HINT);
  }
}

// A 64-char hex string -> 32-byte array. Rejects anything that is not a clean
// 32-byte sha256 (which every Nostr event id is).
function hexIdToBytes(idHex) {
  const s = String(idHex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) {
    throw new Error('anchor: expected a 32-byte hex event id (64 hex chars), got: ' + idHex);
  }
  const out = new Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Submit an already-signed event id (a sha256) to public OpenTimestamps calendar
// servers and return the serialized .ots proof, base64-encoded, to store out of
// band. The proof is PENDING: the calendars will fold the hash into a Bitcoin
// block over the next few hours. Verify (and upgrade) later with verifyAnchor.
export async function anchorEventId(idHex, { calendars } = {}) {
  const OpenTimestamps = await loadOTS();
  const { DetachedTimestampFile, Ops } = OpenTimestamps;
  const digest = hexIdToBytes(idHex);

  // fromHash with OpSHA256 says "this 32-byte value IS the sha256 to timestamp"
  // (no re-hashing) — the event id itself becomes the timestamp message.
  const detached = DetachedTimestampFile.fromHash(new Ops.OpSHA256(), digest);
  const opts = {};
  if (Array.isArray(calendars) && calendars.length) opts.calendars = calendars;
  await OpenTimestamps.stamp(detached, opts);

  const bytes = detached.serializeToBytes();
  const otsBase64 = Buffer.from(bytes).toString('base64');
  return { otsBase64, pending: true };
}

// Verify a stored .ots proof against the event id it should commit to.
// Returns { ok, bitcoin: {height,time}|null, pending, detail }:
//  - ok:      the proof deserializes and commits to exactly this idHex.
//  - bitcoin: {height,time} once a Bitcoin attestation confirms; null while pending.
//  - pending: true when no confirmed Bitcoin attestation exists yet (the honest
//             common case for hours after anchoring).
// A committed-but-unconfirmed proof is still `ok` (the calendar holds the promise);
// it is simply `pending` until Bitcoin confirms. We never fabricate a height.
export async function verifyAnchor(idHex, otsBase64) {
  const OpenTimestamps = await loadOTS();
  const { DetachedTimestampFile, Context, Utils } = OpenTimestamps;

  let wantHex;
  try {
    wantHex = Utils.bytesToHex(hexIdToBytes(idHex));
  } catch (e) {
    return { ok: false, bitcoin: null, pending: false, detail: (e && e.message) || String(e) };
  }

  let detached;
  try {
    const raw = Buffer.from(String(otsBase64 || ''), 'base64');
    const ctx = new Context.StreamDeserialization(Array.from(raw));
    detached = DetachedTimestampFile.deserialize(ctx);
  } catch (e) {
    return { ok: false, bitcoin: null, pending: false, detail: 'could not read the .ots proof: ' + ((e && e.message) || e) };
  }

  // The proof must commit to THIS id, not some other file.
  const gotHex = Utils.bytesToHex(detached.timestamp.msg);
  if (gotHex !== wantHex) {
    return {
      ok: false, bitcoin: null, pending: false,
      detail: 'proof does not commit to this id (proof is for ' + gotHex + ')'
    };
  }

  // Upgrade (pull any newly-available Bitcoin attestation from the calendars)
  // and verify. verify() takes (detachedStamped, detachedOriginal, options) and
  // compares their file digests; for a hash anchor the "original" is the same
  // detached (its fileDigest IS the id we committed to), so we pass it twice.
  // Both touch the network; a failure here does not invalidate the commitment,
  // it only means Bitcoin confirmation is not available yet.
  let bitcoin = null;
  let detail = 'This id existed by the time it was anchored. Bitcoin confirmation is still pending (it can take a few hours).';
  try {
    try { await OpenTimestamps.upgrade(detached); } catch (e) { /* still pending / offline; keep going */ }
    const result = await OpenTimestamps.verify(detached, detached, { ignoreBitcoinNode: true });
    const btc = result && (result.bitcoin || result.litecoin || Object.values(result)[0]);
    if (btc && (btc.timestamp != null || btc.height != null)) {
      bitcoin = { height: btc.height != null ? btc.height : null, time: btc.timestamp != null ? btc.timestamp : null };
      const when = bitcoin.time != null ? new Date(bitcoin.time * 1000).toISOString() : 'a confirmed block';
      detail = 'Confirmed in the Bitcoin blockchain at block ' + bitcoin.height + ' (' + when + ').';
    }
  } catch (e) {
    detail = 'This id existed by the time it was anchored; Bitcoin confirmation still pending (' + ((e && e.message) || e) + ').';
  }

  return { ok: true, bitcoin, pending: bitcoin == null, detail };
}

// Convenience: build + sign + publish in one call, returning links + report.
export async function inscribe({ content, client, type, town, sk, relays, NostrTools, meshFrom, meshFromName, extraTags }) {
  const tpl = buildRecord({ content, client, type, town, meshFrom, meshFromName, extraTags });
  const event = signRecord(tpl, sk, NostrTools);
  const links = recordLinks(event, NostrTools, relays);
  const report = await publishRecord(event, relays, NostrTools);
  return { event, ...links, ...report };
}

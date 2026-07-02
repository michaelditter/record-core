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
// publish that other relays accepted.
export async function publishRecord(event, relays, NostrTools) {
  if (!NostrTools || typeof NostrTools.SimplePool !== 'function') {
    throw new Error('publishRecord: pass a nostr-tools instance as the third argument');
  }
  const list = (relays && relays.length ? relays : CRP.DEFAULT_RELAYS).slice();
  const pool = new NostrTools.SimplePool();
  const settled = await Promise.allSettled(pool.publish(list, event));
  const per = list.map((relay, i) => ({
    relay,
    ok: settled[i].status === 'fulfilled',
    error: settled[i].status === 'rejected'
      ? String((settled[i].reason && settled[i].reason.message) || settled[i].reason)
      : null
  }));
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

// Convenience: build + sign + publish in one call, returning links + report.
export async function inscribe({ content, client, type, town, sk, relays, NostrTools, meshFrom, meshFromName, extraTags }) {
  const tpl = buildRecord({ content, client, type, town, meshFrom, meshFromName, extraTags });
  const event = signRecord(tpl, sk, NostrTools);
  const links = recordLinks(event, NostrTools, relays);
  const report = await publishRecord(event, relays, NostrTools);
  return { event, ...links, ...report };
}

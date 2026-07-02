# record-core

**The shared core of the [You Cannot Eat Code](https://youcannoteat.codes) tool family.** One small, tested library that builds, signs, publishes, and verifies civic records on [Nostr](https://github.com/nostr-protocol/nostr), so `the-record`, `the-charter`, `the-mesh`, and the site all speak the same grammar and a fix in one place is a fix in all of them.

It is the reference implementation of the **[Civic Record Protocol (CRP)](https://github.com/michaelditter/civic-record-protocol)**.

- **Dependency-light.** The pure builders need nothing. Signing, publishing, and verifying take an *injected* `nostr-tools` instance, so the identical code runs in Node (the CLIs) and in the browser (`window.NostrTools`).
- **No build step.** Plain ES modules.
- **Honest about durability.** A record lives as long as one relay keeps a copy. Durability comes from publishing to several independent relays, not from a promise of permanence.

## Install

```bash
npm install @youcannoteat/record-core nostr-tools
```

In the browser, load the `nostr-tools` bundle and import `record-core` as an ES module; pass `window.NostrTools` in wherever a `NostrTools` argument is required.

## Quickstart (Node)

```js
import * as NostrTools from 'nostr-tools';
import { inscribe, buildRecord, signRecord, verifyRecord, CRP } from '@youcannoteat/record-core';

const sk = NostrTools.generateSecretKey(); // or load your own; or use a NIP-07 signer in the browser

// build + sign + publish in one call
const out = await inscribe({
  content: 'On July 2, 2026 the assembly voted 5-2 to keep the green a commons.',
  client: 'the-record',
  type: 'minutes',
  town: { name: 'Goshen', state: 'CT', display: 'Goshen, CT' },
  sk,
  NostrTools
});

console.log(out.njump);              // https://njump.me/nevent1... — verify on any client
console.log(out.accepted, '/', out.total, 'relays'); // durability = how many independent copies
```

## Verify anything

```js
import { verifyRecord } from '@youcannoteat/record-core';

const v = verifyRecord(event, NostrTools);
// { valid: true, crpCompliant: true, reasons: [] }
```

`valid` means the Schnorr signature checks out against the event's pubkey — only the holder of that key could have written it. `crpCompliant` additionally means it carries the CRP tags (`client`, `t=youcannoteat`, `t=civic-record`). The two are reported separately: a note can be signature-valid without being a CRP record.

## API

| Function | Purpose |
|---|---|
| `buildRecord({ content, client, type?, town?, ... })` | Unsigned kind-1 civic record with CRP tags. |
| `buildCharter({ content, d, title?, summary?, prev?, ... })` | Unsigned kind-30023 (NIP-23) replaceable charter. `d` is required. |
| `civicTags({ client, type?, town?, meshFrom?, ... })` | Just the CRP tag array. |
| `townSlug(name, state)` | `'town-ct-goshen'` — the queryable town slug (`#t` filter). |
| `signRecord(template, sk, NostrTools)` | Finalize (sign) a template. |
| `publishRecord(event, relays, NostrTools)` | Publish to several relays; returns a per-relay accept/fail report. |
| `recordLinks(event, NostrTools, relays?)` | `{ nevent, npub, njump }`. |
| `verifyRecord(event, NostrTools)` | `{ valid, crpCompliant, reasons }`. |
| `inscribe({ ... , sk, NostrTools })` | build + sign + publish, returns links + report. |
| `anchorEventId(idHex, { calendars? })` | OpenTimestamps proof-of-existence for a signed event id. Returns `{ otsBase64, pending: true }`. |
| `verifyAnchor(idHex, otsBase64)` | Check a stored proof. Returns `{ ok, bitcoin: {height,time}\|null, pending, detail }`. |
| `CRP` | `{ VERSION, KINDS, DEFAULT_RELAYS, TYPES, ... }`. |

## Anchoring in time (OpenTimestamps)

A Nostr signature proves **authorship**: this key wrote this. It does not, by itself, prove **when**. [OpenTimestamps](https://opentimestamps.org) closes that gap by folding a hash into the Bitcoin blockchain through free public calendar servers, giving a **proof of existence**: this exact id existed by this time.

```js
import { anchorEventId, verifyAnchor } from '@youcannoteat/record-core';

// after you have a signed event:
const { otsBase64, pending } = await anchorEventId(event.id); // pending === true
// store otsBase64 out of band (a sidecar .ots file, a URL). Do NOT put it in the event.

// hours later, once Bitcoin has confirmed:
const v = await verifyAnchor(event.id, otsBase64);
// { ok: true, bitcoin: { height, time } | null, pending, detail }
```

Requires the optional `opentimestamps` package (`npm i opentimestamps`); the functions throw a clear install hint if it is missing.

**What it proves:** that this id existed no later than the anchored time. **What it does not prove:** *who* wrote it (that is the signature's job) or *that the claim is true*. And it is not instant: the calendar promises to include the hash in a future Bitcoin block, and that block takes **a few hours** to confirm. Until then the proof is honestly `pending` — `verifyAnchor` reports the commitment as real but the Bitcoin height as `null`, and never invents a confirmation it does not have.

**Out of band, by design.** OTS anchors an *already-signed* id (a sha256). The `.ots` proof is created *after* signing and cannot be embedded in the event: doing so would change the id it commits to. Store and share the proof separately. The CRP reserved `ots` tag is for out-of-band *references* to a proof, never for the proof bytes.

## The grammar in one glance

Every record carries `['client', '<tool>']`, `['t', 'youcannoteat']`, and `['t', 'civic-record']`. Town-scoped records add `['t', 'town-<state>-<name>']` so a whole town's public record is one `#t` query away. Charters are addressable kind-30023 events with a stable `d` and an optional `prev` amendment chain. The full grammar, including provenance (`mesh_from`) and the reserved OpenTimestamps anchor, is the [Civic Record Protocol spec](https://github.com/michaelditter/civic-record-protocol).

## Test

```bash
npm test                    # real sign -> verify roundtrip + tamper rejection, no network
RECORD_CORE_LIVE=1 npm test # also publish to a real relay and fetch it back
```

## License

MIT — see [LICENSE](LICENSE).

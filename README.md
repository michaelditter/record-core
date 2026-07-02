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
| `CRP` | `{ VERSION, KINDS, DEFAULT_RELAYS, TYPES, ... }`. |

## The grammar in one glance

Every record carries `['client', '<tool>']`, `['t', 'youcannoteat']`, and `['t', 'civic-record']`. Town-scoped records add `['t', 'town-<state>-<name>']` so a whole town's public record is one `#t` query away. Charters are addressable kind-30023 events with a stable `d` and an optional `prev` amendment chain. The full grammar, including provenance (`mesh_from`) and the reserved OpenTimestamps anchor, is the [Civic Record Protocol spec](https://github.com/michaelditter/civic-record-protocol).

## Test

```bash
npm test                    # real sign -> verify roundtrip + tamper rejection, no network
RECORD_CORE_LIVE=1 npm test # also publish to a real relay and fetch it back
```

## License

MIT — see [LICENSE](LICENSE).

# Agent guide: @voxgig/seneca-browser-store

Browser-side Seneca state cache with optimistic writes and message-based
reactivity. Concepts: [README.md](README.md) + [docs/](docs/).

## Commands

```bash
npm test        # node:test (test/store.test.js)
```

Plain JS, no build step: `browser-store.js` is the source AND the shipped
artifact (plus `browser-store.d.ts` types). Works as ESM import and as a
global script tag.

## Hard rules

- **Pass-through semantics are inviolable**: a miss must call through, a
  write must reach the server, errors must surface unchanged. Never let a
  cache feature change message behaviour.
- Interception is an **ordu inward/outward pair** — do NOT refactor to
  `seneca.wrap` (the browser transport's client pin action doesn't exist
  at plugin-load time) and do not reorder around the transport init.
- Cache-hit short-circuit uses `{op:'stop', out:{kind:'result', result}}`
  from the inward hook — the exact shape matters to seneca's ordu.
- Write invalidation must stay **synchronous** (before the caller's
  callback) — a read right after a write must re-fetch; a test pins this.
- Verb classification is by message KEY (`list:item`), not value —
  `{cmd:'list'}`-style messages are unclassified and pass through. Known
  consumer impact: `@voxgig/build`'s generic `aim:ent,cmd:*` service is
  NOT cached by default options.

## Gotchas

- The plugin must be registered AFTER `.client(...)`.
- Optimistic creates use temp ids (`__opt_*`) until reconciled.
- Publishing: first publish to npm must be direct (`npm publish`, needs
  interactive browser 2FA); see the voxgig staged-publish notes.

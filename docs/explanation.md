# Explanation

*Diátaxis: explanation — the design decisions behind the store.*

## Why interception is an ordu inward/outward pair

The cache is installed as an **ordu inward/outward** hook pair on the
Seneca message pipeline (the same mechanism seneca-browser uses internally
for `debounce`) — not `seneca.wrap`.

Two reasons. First, `wrap` requires the target action to exist when the
plugin loads, but the browser transport's client pin action is only wired
during transport init — a load-order trap. The pipeline hooks run for
every message regardless of transport and have no such dependency. Second,
the inward hook can short-circuit a cache hit with
`{op:'stop', out:{kind:'result', result}}`, so a hit never reaches the
transport at all: no network round-trip, not even a local action
dispatch. The outward hook then caches successful read results and
invalidates groups on successful writes.

## Why reactivity is message-based

When cached data changes, the store emits a plain Seneca message
(`changed:group`) rather than invoking registered callbacks. `seneca.sub`
is already a native fan-out (many observers per pattern), so views get
Redux-like "subscribe to the slice you render" behaviour with **no second
runtime**: the same primitive that carries data messages carries change
notifications, appears in the debugger's message log, and works across
any component structure.

## Why optimistic-by-default

The store already knows the shape of cached lists and the identity field,
so it can apply a write's effect locally and reconcile with the server's
authoritative reply — giving instant UI updates for the common case. The
design accepts two consequences and makes them explicit: a temp-id window
for creates (UI should avoid acting on unreconciled rows), and a
UI-confirmed ≠ server-confirmed gap (await the reply when confirmation
matters). Where the store *cannot* know the effect — filtered or sorted
queries — it deliberately falls back to invalidation, trading a re-fetch
for correctness.

## Pass-through as a hard rule

The store never changes message semantics: a miss calls through, a write
always goes to the server, errors surface unchanged (plus a group
invalidation to restore truth). This keeps it safe to add to an existing
app — removing the plugin changes performance, never behaviour.

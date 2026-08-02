# Reference

*Diátaxis: reference — options, API, and messages.*

## Options

| Option     | Default                                   | Description                                   |
| ---------- | ----------------------------------------- | --------------------------------------------- |
| `pin`      | `'aim:*'`                                  | Pins to intercept (string or array).          |
| `read`     | `['list','load','get','read','query']`     | Verb keys marking a cacheable read.           |
| `write`    | `['save','remove','update','delete',...]`  | Verb keys marking an invalidating write.      |
| `zoneKey`  | `'aim'`                                    | Key holding the zone (used in the group id).  |
| `ttl`      | `null`                                     | Per-entry TTL in ms (null = no expiry).       |
| `max`      | `500`                                      | Max entries; oldest evicted first.            |
| `ignore`   | `['gateway$']`                             | Keys excluded from the cache key.             |
| `optimistic` | `true`                                   | Update cached lists in place on write.        |
| `idField`  | `'id'`                                     | Entity identity field.                        |
| `listFields` | `['list','items']`                       | Keys inside a cached value holding entity arrays. |
| `removeVerbs` | `['remove','delete']`                   | Write verbs treated as deletions.             |

The cache **group** is `<zone>/<entity>`: zone = value of `zoneKey`,
entity = value of the verb key. So a `{aim:'todo', save:'item'}` write
invalidates the cached `{aim:'todo', list:'item'}` / `load:item` reads.

## Programmatic API

```js
const api = seneca.export('browser-store/api')
```

| Method | Description |
|---|---|
| `api.state()` | The Redux-like tree, grouped by zone/entity |
| `api.stats()` | `{ hits, misses, sets, invalidations, evictions }` |
| `api.entries()` | Entry count |
| `api.clear()` | Empty the cache |
| `api.invalidate(group)` | Invalidate one group |

## Messages

Act (request/response):

| Message | Description |
|---|---|
| `sys:browser-store,get:state` | The state tree |
| `sys:browser-store,get:stats` | Counters |
| `sys:browser-store,clear:store` | Empty the cache |
| `sys:browser-store,invalidate:group` (`group`) | Invalidate one group |

Change events (observe with `seneca.sub`):

| Message | Emitted |
|---|---|
| `sys:browser-store,changed:group` (`group`) | On a successful write and on `invalidate:group` |
| `sys:browser-store,changed:all` | On `clear:store` |

## Invalidation timing

Writes invalidate their group synchronously on success, before the
caller's callback runs — a read issued right after a write always
re-fetches.

## Optimistic update semantics

- **create** (`save` with no id): appended with a temporary id (`__opt_*`),
  reconciled to the server's authoritative entity on reply.
- **update** (`save` with id): the matching row is replaced, then reconciled.
- **delete** (`removeVerbs` with id): the row is dropped.
- **error**: the group is invalidated so views re-fetch the true state.
- Only *unfiltered* list reads (nothing beyond zone + verb) are updated in
  place; filtered/sorted queries are invalidated and re-fetch.

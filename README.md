# @seneca/browser-store

A Redux-like **state cache** for [Seneca][] running in the browser. It sits
transparently in front of the remote (backend) message pins and caches query
results, so repeated reads are served from an in-memory state tree instead of
hitting the server again. Writes update the cache **optimistically** (in place,
before the server replies) and reconcile with the authoritative result — so the
UI updates instantly and the cache does not go stale.

It is a **pass-through** cache: it never changes message semantics. On a cache
miss it calls through to the real (transported) action, stores the result, and
returns it.

**Reactivity is message-based.** When cached data changes, the store emits a
Seneca message that any component can observe with `seneca.sub` (Seneca's
native fan-out - many observers per pattern). There is no separate reactive
runtime or callback registry; reactivity uses the same messaging primitive as
everything else:

- `sys:browser-store,changed:group` `{ group }` — emitted on a successful
  write (and on `invalidate:group`); names the affected `<zone>/<entity>`.
- `sys:browser-store,changed:all` — emitted on `clear:store`.

A view subscribes to the groups it depends on and re-renders when they change,
regardless of which component performed the write:

```js
seneca.sub('sys:browser-store,changed:group', (msg) => {
  if (msg.group === myGroup) refresh()
})
```

Pairs with [`@seneca/browser-debug`][browser-debug], whose **Store** tab shows
the live cache as a tree.

## Install

```sh
npm install @seneca/browser-store
```

## Usage

Register the plugin **after** `.client(...)`, so the remote pin actions exist.

```js
import Seneca from '@seneca/browser'
import SenecaBrowserStore from '@seneca/browser-store'

const seneca = Seneca({ legacy: false }).client({ type: 'browser', pin: 'aim:*' })
seneca.use(SenecaBrowserStore, { pin: 'aim:*' })
```

Or as a global script tag (alongside `seneca-browser.js`):

```html
<script src="/seneca-browser.js"></script>
<script src="/seneca-browser-store.js"></script>
<script>
  const seneca = Seneca({ legacy: false }).client({ type: 'browser', pin: 'aim:*' })
  seneca.use(SenecaBrowserStore, { pin: 'aim:*' })
</script>
```

That's it — reads on `aim:*` are now cached and writes invalidate them.

## How it decides what to cache

All configurable via options:

- A message is a **read** (cacheable) if it carries one of the `read` verb
  keys (`list`, `load`, `get`, ...).
- A message is a **write** (invalidating) if it carries one of the `write` verb
  keys (`save`, `remove`, `update`, ...).
- The cache **group** for invalidation is `<zone>/<entity>`, where the zone is
  the value of `zoneKey` (default `aim`) and the entity is the value of the
  verb key. So a `{aim:'todo', save:'item'}` write invalidates the cached
  `{aim:'todo', list:'item'}` / `load:item` reads.

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

## Optimistic updates

By default (`optimistic: true`) a write mutates the cached list(s) in the group
**before** the message reaches the server, and emits `changed:group` — so views
re-render from cache immediately, with no round-trip:

- **create** (`save` with no id): the item is appended with a temporary id,
  then reconciled to the server's authoritative entity (real id) on reply.
- **update** (`save` with id): the matching row is replaced, then reconciled.
- **delete** (`remove`/`delete` with id): the row is dropped from the list.
- On **error**, the group is invalidated so views re-fetch the true state.

Configured by `idField` (default `id`), `listFields` (arrays inside a cached
read value, default `['list','items']`), and `removeVerbs`. Set
`optimistic: false` to fall back to invalidate-on-write.

Notes and caveats:
- **Filtered/sorted queries**: an optimistic upsert can't know a query's filter
  or sort, so only *unfiltered* list reads (nothing beyond zone + verb) are
  updated in place; filtered ones are invalidated and re-fetch.
- **The temp-id window**: a freshly-created row briefly carries a temp id
  (`__opt_*`) until the server replies. Avoid issuing further writes against a
  row until it reconciles (e.g. disable row actions on temp-id rows).
- **UI-confirmed ≠ server-confirmed**: the UI reflects the change before the
  server does; await the write's reply when you need server confirmation.

## Avoiding staleness

- Writes invalidate their group synchronously on success, before the caller's
  callback runs — so a read issued right after a write always re-fetches.
- Set `ttl` to bound staleness from mutations made by *other* clients.
- The cache is principal-scoped in effect (results depend on the auth cookie).
  Clear it when the signed-in user changes:

  ```js
  onAuthChange(() => seneca.act('sys:browser-store,clear:store', () => {}))
  ```

## Programmatic API

```js
const api = seneca.export('browser-store/api')
api.state()            // the Redux-like tree, grouped by zone/entity
api.stats()            // { hits, misses, sets, invalidations, evictions }
api.entries()          // entry count
api.clear()            // empty the cache
api.invalidate(group)  // invalidate one group
```

Equivalent messages: `sys:browser-store,get:state`,
`sys:browser-store,get:stats`, `sys:browser-store,clear:store`,
`sys:browser-store,invalidate:group` (with `group`).

Change events (observe with `sub`): `sys:browser-store,changed:group`
(with `group`), `sys:browser-store,changed:all`.

## How interception works

The cache is installed as an **ordu inward/outward** pair on the Seneca
pipeline (the same mechanism seneca-browser uses internally for `debounce`) —
not `seneca.wrap`. The inward hook short-circuits a cache hit with
`{op:'stop', out:{kind:'result', result}}`, so the message never reaches the
transport (no network round-trip). The outward hook caches a successful read
result and invalidates the group on a successful write. This runs for every
message regardless of transport, and does not depend on the target pin action
already existing when the plugin loads (the browser transport client pin is
only wired up during transport init).

## License

MIT

[Seneca]: https://senecajs.org
[browser-debug]: https://github.com/voxgig/seneca-browser-debug

# How-to guides

*Diátaxis: how-to — recipes for common tasks. Options detail:
[reference](reference.md).*

## Match your message verbs

A message is classified by its **verb keys**: a read if it carries one of
`read` (`list`, `load`, `get`, `read`, `query`), a write if one of `write`
(`save`, `remove`, `update`, `delete`, ...). If your app uses different
verbs, extend the lists:

```js
seneca.use(SenecaBrowserStore, {
  pin: 'aim:*',
  read: ['list', 'load', 'get', 'fetch'],
  write: ['save', 'remove', 'archive'],
})
```

Note: verbs are message KEYS (`list:item`), not values — a message like
`{cmd:'list'}` (verb as value) is not classified and passes through
uncached.

## Clear the cache when the user changes

Results depend on the auth cookie, so the cache is principal-scoped in
effect. Clear it on sign-in/out:

```js
onAuthChange(() => seneca.act('sys:browser-store,clear:store', () => {}))
```

## Bound staleness from other clients

Writes made by *other* browsers can't invalidate your cache. Give entries
a TTL:

```js
seneca.use(SenecaBrowserStore, { pin: 'aim:*', ttl: 30_000 })
```

## Disable or tune optimistic updates

```js
// Fall back to invalidate-on-write (views re-fetch after the server replies):
seneca.use(SenecaBrowserStore, { pin: 'aim:*', optimistic: false })

// Tune identity and list shapes:
seneca.use(SenecaBrowserStore, {
  pin: 'aim:*',
  idField: 'id',
  listFields: ['list', 'items', 'rows'],
  removeVerbs: ['remove', 'delete', 'archive'],
})
```

Guard the temp-id window in the UI: a freshly-created row briefly carries
a temporary id (`__opt_*`) until the server replies — disable row actions
on such rows, and await the write's reply when you need server
confirmation.

## Invalidate or inspect programmatically

```js
const api = seneca.export('browser-store/api')
api.invalidate('todo/item')   // force re-fetch of one group
api.state()                   // the Redux-like tree
api.stats()                   // { hits, misses, sets, invalidations, evictions }
api.clear()
```

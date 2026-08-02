# @voxgig/seneca-browser-store

A Redux-like **state cache** for [Seneca][] running in the browser. It sits
transparently in front of the remote (backend) message pins and caches query
results, so repeated reads are served from an in-memory state tree instead of
hitting the server again. Writes update the cache **optimistically** (in place,
before the server replies) and reconcile with the authoritative result — so the
UI updates instantly and the cache does not go stale.

It is a **pass-through** cache: it never changes message semantics. And
**reactivity is message-based**: when cached data changes, the store emits a
Seneca message (`sys:browser-store,changed:group`) that any component can
observe with `seneca.sub` — no separate reactive runtime.

Pairs with [`@voxgig/seneca-browser-debug`][browser-debug], whose **Store**
tab shows the live cache as a tree.

## Install

```sh
npm install @voxgig/seneca-browser-store
```

## Quick start

Register the plugin **after** `.client(...)`:

```js
import Seneca from '@seneca/browser'
import SenecaBrowserStore from '@voxgig/seneca-browser-store'

const seneca = Seneca({ legacy: false }).client({ type: 'browser', pin: 'aim:*' })
seneca.use(SenecaBrowserStore, { pin: 'aim:*' })
```

That's it — reads on `aim:*` are now cached, writes invalidate (and
optimistically update) them.

## Documentation

Organised by the [Diátaxis](https://diataxis.fr) framework:

- **Tutorial**: [Cache and react to data](docs/tutorial.md)
- **How-to guides**: [Common tasks](docs/how-to.md) — configure verbs,
  clear on auth change, bound staleness, tune or disable optimism
- **Reference**: [Options, API, messages](docs/reference.md)
- **Explanation**: [How interception and optimism work](docs/explanation.md)

Working on this repo with an AI agent? See [AGENTS.md](AGENTS.md).

## License

MIT

[Seneca]: https://senecajs.org
[browser-debug]: https://github.com/voxgig/seneca-browser-debug

# Tutorial: cache and react to data

*Diátaxis: tutorial — wire the store into a browser Seneca app and build a
view that reacts to writes made anywhere in the app.*

## 1. Set up

```js
import Seneca from '@seneca/browser'
import SenecaBrowserStore from '@voxgig/seneca-browser-store'

const seneca = Seneca({ legacy: false })
  .client({ type: 'browser', pin: 'aim:*' })   // remote pin first
seneca.use(SenecaBrowserStore, { pin: 'aim:*' })
```

Order matters: the client transport declares which pins are remote; the
store then intercepts those messages.

## 2. Watch the cache work

```js
// First call: cache miss -> network -> cached.
await seneca.post('aim:todo,list:item')
// Second call: served from the cache, no network round-trip.
await seneca.post('aim:todo,list:item')
```

(If you also load `@voxgig/seneca-browser-debug`, its **Store** tab shows
the state tree filling up, and the Messages tab shows the second read
never leaving the browser.)

## 3. React to changes

The store emits `sys:browser-store,changed:group` `{ group }` whenever a
group's data changes — from a write, an optimistic update, or an
invalidation. A view subscribes to the groups it renders:

```js
const myGroup = 'todo/item'

seneca.sub('sys:browser-store,changed:group', (msg) => {
  if (msg.group === myGroup) refresh()
})

async function refresh() {
  const out = await seneca.post('aim:todo,list:item')  // cheap: cached
  render(out.list)
}
```

## 4. Make a write — from anywhere

```js
await seneca.post('aim:todo,save:item', { item: { title: 'Try the store' } })
```

The cached `todo/item` lists are updated **optimistically** (the new row
appears before the server replies, with a temporary id, and is reconciled
to the real entity on reply), `changed:group` fires, and your view
re-renders — regardless of which component performed the write. That's the
whole reactive loop: *write → cache update → message → re-render*, all on
Seneca primitives.

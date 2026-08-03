/* Headless tests for the transparent pass-through query cache, including
 * optimistic updates. */

const { test } = require('node:test')
const assert = require('node:assert')

// Which seneca-browser to test against.
//
// Default: the pinned package, so CI and a clean checkout are
// deterministic. Set SENECA_BROWSER_SIBLING=1 to use a sibling checkout
// (../../seneca-browser) instead, for validating unreleased upstream
// changes - an explicit opt-in, because silently preferring whatever
// happens to sit two directories up would defeat the version pin.
//
// require.resolve() decides PRESENCE; the require() itself is outside the
// try, so an error thrown while EVALUATING a found package propagates
// instead of being mistaken for "not installed".
function loadSeneca() {
  if (process.env.SENECA_BROWSER_SIBLING) {
    return require('../../seneca-browser/seneca-browser.js')
  }

  for (const id of ['@seneca/browser', 'seneca-browser']) {
    let found = null
    try {
      found = require.resolve(id)
    }
    catch (e) {
      // Not installed under this name; try the next.
      continue
    }
    return require(found)
  }

  return require('../../seneca-browser/seneca-browser.js')
}

const Seneca = loadSeneca()

const BrowserStore = require('../browser-store.js')

// Build a bus with a fake backend behind `aim:*` that mimics seneca-entity:
// list -> {ok, list:[...]}, save -> {ok, item:<entity with id>}, remove -> {ok}.
// The store plugin must be registered AFTER the pin actions exist so its
// ordu hooks can intercept them.
function make(storeOpts) {
  const seneca = Seneca({ legacy: false, log: 'silent' })
  const calls = { list: 0, save: 0, remove: 0, other: 0 }
  const db = [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }]

  seneca.add('aim:todo,list:item', function (m, r) {
    calls.list++
    r(null, { ok: true, list: db.map((x) => Object.assign({}, x)), q: m.q || null, call: calls.list })
  })
  seneca.add('aim:todo,save:item', function (m, r) {
    if (m.item && m.item.fail) {
      return r(new Error('save failed'))
    }
    calls.save++
    const item = Object.assign({ id: m.item.id || 'srv' + calls.save }, m.item)
    r(null, { ok: true, item: item })
  })
  seneca.add('aim:todo,remove:item', function (m, r) {
    calls.remove++
    r(null, { ok: true })
  })
  seneca.add('aim:req,ping:x', function (m, r) {
    calls.other++
    r(null, { pong: true })
  })
  seneca.use(BrowserStore, Object.assign({ pin: 'aim:*' }, storeOpts))
  return { seneca, calls }
}

function ready(seneca) {
  return new Promise(function (done) {
    seneca.ready(done)
  })
}

function wait(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms || 40)
  })
}

test('read is cached; identical read served from cache (no backend hit)', async function () {
  const { seneca, calls } = make()
  await ready(seneca)

  await seneca.post('aim:todo,list:item')
  await seneca.post('aim:todo,list:item')

  assert.equal(calls.list, 1, 'backend hit only once for two identical reads')
  const api = seneca.export('browser-store/api')
  assert.equal(api.stats().hits, 1)
  assert.equal(api.stats().misses, 1)
  assert.equal(api.entries(), 1)
})

test('distinct query params are cached separately', async function () {
  const { seneca, calls } = make()
  await ready(seneca)

  await seneca.post('aim:todo,list:item,q:open')
  await seneca.post('aim:todo,list:item,q:done')
  await seneca.post('aim:todo,list:item,q:open')

  assert.equal(calls.list, 2)
  assert.equal(seneca.export('browser-store/api').entries(), 2)
})

test('OPTIMISTIC create: cached list updated in place, no refetch, reconciled to server id', async function () {
  const { seneca, calls } = make()
  await ready(seneca)

  await seneca.post('aim:todo,list:item') // cache the list (call 1)
  await seneca.post('aim:todo,save:item', { item: { title: 'C' } })
  await wait()

  // The next read is served from the optimistically-updated cache - no
  // second list call to the backend.
  const out = await seneca.post('aim:todo,list:item')
  assert.equal(calls.list, 1, 'no refetch: the cached list was updated in place')

  const titles = out.list.map((x) => x.title)
  assert.ok(titles.indexOf('C') >= 0, 'new item present in cached list')
  const created = out.list.find((x) => x.title === 'C')
  assert.equal(created.id, 'srv1', 'reconciled to the server-assigned id (temp id replaced)')
  assert.ok(!out.list.some((x) => String(x.id).indexOf('__opt_') === 0), 'no temp-id rows remain')

  assert.ok(seneca.export('browser-store/api').stats().optimistic >= 1)
})

test('OPTIMISTIC update: existing row replaced in cached list, no refetch', async function () {
  const { seneca, calls } = make()
  await ready(seneca)

  await seneca.post('aim:todo,list:item')
  await seneca.post('aim:todo,save:item', { item: { id: 't1', title: 'A-edited' } })
  await wait()

  const out = await seneca.post('aim:todo,list:item')
  assert.equal(calls.list, 1, 'no refetch')
  const t1 = out.list.find((x) => x.id === 't1')
  assert.equal(t1.title, 'A-edited')
  assert.equal(out.list.length, 2, 'still two rows (updated, not appended)')
})

test('OPTIMISTIC remove: row dropped from cached list, no refetch', async function () {
  const { seneca, calls } = make()
  await ready(seneca)

  await seneca.post('aim:todo,list:item')
  await seneca.post('aim:todo,remove:item', { id: 't1' })
  await wait()

  const out = await seneca.post('aim:todo,list:item')
  assert.equal(calls.list, 1, 'no refetch')
  assert.ok(!out.list.some((x) => x.id === 't1'), 't1 removed from cached list')
  assert.equal(out.list.length, 1)
})

test('non-optimistic mode invalidates on write and refetches', async function () {
  const { seneca, calls } = make({ optimistic: false })
  await ready(seneca)

  await seneca.post('aim:todo,list:item') // call 1
  await seneca.post('aim:todo,save:item', { item: { title: 'Z' } })
  await wait()
  await seneca.post('aim:todo,list:item') // invalidated -> call 2

  assert.equal(calls.list, 2)
})

test('a failed write heals by invalidating the group (refetch)', async function () {
  const { seneca, calls } = make()
  await ready(seneca)

  await seneca.post('aim:todo,list:item') // call 1, cached
  await new Promise(function (r) {
    seneca.act('aim:todo,save:item', { item: { title: 'bad', fail: true } }, function () {
      r()
    })
  })
  await wait()
  await seneca.post('aim:todo,list:item') // group healed -> call 2

  assert.equal(calls.list, 2, 'optimistic guess discarded on error; refetched')
})

test('get:state exposes a grouped tree; clear empties it', async function () {
  const { seneca } = make()
  await ready(seneca)

  await seneca.post('aim:todo,list:item')
  const state = await seneca.post('sys:browser-store,get:state')

  assert.ok(state.ok)
  assert.ok(state.state['todo/item'])
  assert.equal(state.state['todo/item'].count, 1)

  await seneca.post('sys:browser-store,clear:store')
  const after = await seneca.post('sys:browser-store,get:state')
  assert.equal(after.entries, 0)
})

test('non read/write messages pass through and are not cached', async function () {
  const { seneca, calls } = make()
  await ready(seneca)

  await seneca.post('aim:req,ping:x')
  await seneca.post('aim:req,ping:x')

  assert.equal(calls.other, 2)
  assert.equal(seneca.export('browser-store/api').entries(), 0)
})

test('ttl expiry forces a re-fetch', async function () {
  const { seneca, calls } = make({ ttl: 40 })
  await ready(seneca)

  await seneca.post('aim:todo,list:item')
  await seneca.post('aim:todo,list:item')
  assert.equal(calls.list, 1)

  await wait(70)
  await seneca.post('aim:todo,list:item')
  assert.equal(calls.list, 2)
})

test('a write emits a sys:browser-store,changed:group message (reactivity)', async function () {
  const { seneca } = make()
  const changed = []
  seneca.sub('sys:browser-store,changed:group', function (msg) {
    changed.push(msg.group)
  })
  await ready(seneca)

  await seneca.post('aim:todo,list:item')
  await seneca.post('aim:todo,save:item', { item: { title: 'x' } })
  await wait()

  assert.ok(changed.indexOf('todo/item') >= 0, 'save emitted changed:group for todo/item')
})

test('clear emits a sys:browser-store,changed:all message', async function () {
  const { seneca } = make()
  let all = 0
  seneca.sub('sys:browser-store,changed:all', function () {
    all++
  })
  await ready(seneca)
  await seneca.post('sys:browser-store,clear:store')
  await wait(30)
  assert.ok(all >= 1)
})

test('cached value is cloned (callers cannot mutate the cache)', async function () {
  const { seneca } = make()
  await ready(seneca)

  const a = await seneca.post('aim:todo,list:item')
  a.list.push({ id: 'MUT', title: 'mutant' })

  const b = await seneca.post('aim:todo,list:item')
  assert.equal(b.list.length, 2, 'second read unaffected by mutation of the first result')
})

/* Copyright (c) 2026 Richard Rodger, MIT License. */

/*
 * @voxgig/seneca-browser-store
 *
 * A Redux-like state cache for Seneca running in the browser. It sits
 * transparently in front of the remote (backend) message pins and caches
 * query results, so repeated reads are served from an in-memory state tree
 * instead of hitting the server again.
 *
 * Interception uses the ordu inward/outward pipeline (the same mechanism
 * seneca-browser uses for `debounce`), which works over a transport client
 * pin where `seneca.wrap` cannot. On a read miss the value is cached; a write
 * updates the cache OPTIMISTICALLY (mutating the cached list(s) in place
 * before the server replies) and reconciles with the authoritative result -
 * or heals by invalidating on error.
 *
 * Reactivity is message-based: on a change the store emits
 * `sys:browser-store,changed:group` / `changed:all`, which any component can
 * observe with `seneca.sub` (many observers per pattern).
 *
 * How it decides what to cache (all configurable):
 *   - A message is a READ (cacheable) if it carries one of `read` verb keys
 *     (list, load, get, ...).
 *   - A message is a WRITE (invalidating) if it carries one of `write` verb
 *     keys (save, remove, update, ...).
 *   - The cache GROUP for invalidation is derived from the zone key (default
 *     `aim`) and the entity name (the value of the verb key). So a
 *     `save:item` write invalidates the cached `list:item` / `load:item`
 *     reads in the same zone.
 *
 * Usage (global script tag, alongside seneca-browser.js):
 *   seneca.client({ type: 'browser', pin: 'aim:*' })
 *   seneca.use(SenecaBrowserStore, { pin: 'aim:*' })
 *
 * Usage (ESM / bundler):
 *   import SenecaBrowserStore from '@voxgig/seneca-browser-store'
 *   seneca.use(SenecaBrowserStore, { pin: 'aim:*' })
 *
 * IMPORTANT: register the plugin AFTER `.client(...)` so the remote pin
 * actions exist to be wrapped.
 */

;(function (root, factory) {
  'use strict'
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  }
  else {
    root.SenecaBrowserStore = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const SEP = ''

  const DEFAULTS = {
    // Pins to intercept (string or array). These should match the remote
    // client pin(s).
    pin: 'aim:*',
    // Message keys whose presence marks a cacheable read.
    read: ['list', 'load', 'get', 'read', 'query'],
    // Message keys whose presence marks an invalidating write.
    write: ['save', 'remove', 'update', 'delete', 'create', 'done', 'set', 'add'],
    // Key holding the zone/namespace (used in the group id).
    zoneKey: 'aim',
    // Optional per-entry time-to-live in ms (null = rely on write-invalidation).
    ttl: null,
    // Max cached entries (oldest evicted first).
    max: 500,
    // Message keys never included in the cache key (auth/transport noise).
    ignore: ['gateway$'],
    // Optimistic updates: on a write, mutate the cached list(s) in place
    // (before the server replies) and reconcile with the authoritative
    // result, instead of invalidating + refetching. Set false to fall back
    // to invalidate-on-write.
    optimistic: true,
    // Entity identity field, used to upsert/remove within cached lists.
    idField: 'id',
    // Keys inside a cached read value that hold entity arrays.
    listFields: ['list', 'items'],
    // Which write verbs are deletions (the rest are treated as upserts).
    removeVerbs: ['remove', 'delete'],
  }

  function browser_store(options) {
    const seneca = this
    const opts = Object.assign({}, DEFAULTS, options || {})
    opts.read = asArray(opts.read)
    opts.write = asArray(opts.write)
    opts.ignore = asArray(opts.ignore)
    opts.listFields = asArray(opts.listFields)
    opts.removeVerbs = asArray(opts.removeVerbs)
    const pins = asArray(opts.pin)

    const store = {}
    const order = []
    const pending = {}
    let tmpSeq = 0
    const stats = { hits: 0, misses: 0, sets: 0, invalidations: 0, evictions: 0, optimistic: 0 }
    const listeners = []

    function notify() {
      for (let i = 0; i < listeners.length; i++) {
        try {
          listeners[i]()
        }
        catch (e) {
          if (typeof console !== 'undefined') {
            console.error('browser-store listener failed', e)
          }
        }
      }
    }

    function classify(clean) {
      for (let i = 0; i < opts.write.length; i++) {
        if (Object.prototype.hasOwnProperty.call(clean, opts.write[i])) {
          return { kind: 'write', verb: opts.write[i], entity: clean[opts.write[i]] }
        }
      }
      for (let i = 0; i < opts.read.length; i++) {
        if (Object.prototype.hasOwnProperty.call(clean, opts.read[i])) {
          return { kind: 'read', verb: opts.read[i], entity: clean[opts.read[i]] }
        }
      }
      return { kind: 'pass' }
    }

    function groupId(clean, cls) {
      const zone = clean[opts.zoneKey]
      const parts = []
      if (null != zone && 'object' !== typeof zone) {
        parts.push(String(zone))
      }
      if (null != cls.entity && 'object' !== typeof cls.entity) {
        parts.push(String(cls.entity))
      }
      return parts.length ? parts.join('/') : '_'
    }

    function expired(entry) {
      return null != entry.ttl && now() - entry.at > entry.ttl
    }

    function setEntry(ck, gid, clean, value) {
      if (!store[ck]) {
        order.push(ck)
      }
      store[ck] = {
        gid: gid,
        label: patternize(clean),
        query: clean,
        value: value,
        at: now(),
        hits: 0,
        ttl: opts.ttl,
      }
      stats.sets++
      while (order.length > opts.max) {
        const old = order.shift()
        if (store[old]) {
          delete store[old]
          stats.evictions++
        }
      }
    }

    function invalidateGroup(gid) {
      let n = 0
      for (let i = order.length - 1; i >= 0; i--) {
        const ck = order[i]
        if (store[ck] && store[ck].gid === gid) {
          delete store[ck]
          order.splice(i, 1)
          n++
        }
      }
      return n
    }

    function clearAll() {
      for (const k in store) {
        delete store[k]
      }
      order.length = 0
    }

    // Build the Redux-like display tree: { [gid]: { entries: [...], ... } }.
    function tree() {
      const out = {}
      for (let i = 0; i < order.length; i++) {
        const ck = order[i]
        const e = store[ck]
        if (!e) {
          continue
        }
        const g = out[e.gid] || (out[e.gid] = { count: 0, entries: [] })
        g.count++
        g.entries.push({
          label: e.label,
          query: e.query,
          value: e.value,
          at: e.at,
          age: now() - e.at,
          hits: e.hits,
          stale: expired(e),
        })
      }
      return out
    }

    function cacheable(out) {
      return null != out && 'object' === typeof out && true !== out.error
    }

    function keyOf(clean, gid) {
      return gid + SEP + stableStringify(clean)
    }

    // ---- optimistic mutation of cached lists -----------------------------

    // Visit each cached entry in a group; a visitor returning 'delete' drops
    // that entry (used to invalidate reads we can't safely mutate in place).
    function eachGroupEntry(gid, visit) {
      const drop = []
      const cks = order.slice()
      for (let i = 0; i < cks.length; i++) {
        const ck = cks[i]
        const e = store[ck]
        if (e && e.gid === gid) {
          if ('delete' === visit(e)) {
            drop.push(ck)
          }
        }
      }
      for (let i = 0; i < drop.length; i++) {
        const ck = drop[i]
        if (store[ck]) {
          delete store[ck]
          const j = order.indexOf(ck)
          if (j >= 0) {
            order.splice(j, 1)
          }
        }
      }
    }

    function listsOf(value) {
      const out = []
      for (let i = 0; i < opts.listFields.length; i++) {
        const arr = value && value[opts.listFields[i]]
        if (Array.isArray(arr)) {
          out.push(arr)
        }
      }
      return out
    }

    // A read query is "unfiltered" if it carries nothing beyond the zone and
    // its verb key - i.e. it lists a whole collection, so an upsert is safe.
    function isUnfiltered(query, verb) {
      for (const k in query) {
        if (k !== opts.zoneKey && k !== verb) {
          return false
        }
      }
      return true
    }

    function upsertInto(arr, entity) {
      const id = entity[opts.idField]
      let idx = -1
      if (null != id) {
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] && arr[i][opts.idField] === id) {
            idx = i
            break
          }
        }
      }
      if (idx >= 0) {
        arr[idx] = entity
      }
      else {
        arr.push(entity)
      }
    }

    function removeFrom(arr, id) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] && arr[i][opts.idField] === id) {
          arr.splice(i, 1)
        }
      }
    }

    // Upsert an entity into every cached list in a group. Non-list reads and
    // filtered lists (which an upsert can't safely target) are invalidated so
    // they re-fetch. Optionally first remove a temp-id row (create reconcile).
    function upsertGroup(gid, entity, tmpId) {
      const clean = clone(entity)
      eachGroupEntry(gid, function (e) {
        const lists = listsOf(e.value)
        if (0 === lists.length) {
          return 'delete'
        }
        const info = classify(e.query)
        if ('read' !== info.kind || !isUnfiltered(e.query, info.verb)) {
          return 'delete'
        }
        for (let i = 0; i < lists.length; i++) {
          if (null != tmpId) {
            removeFrom(lists[i], tmpId)
          }
          upsertInto(lists[i], clone(clean))
        }
      })
    }

    function removeGroup(gid, id) {
      eachGroupEntry(gid, function (e) {
        const lists = listsOf(e.value)
        if (0 === lists.length) {
          return 'delete'
        }
        for (let i = 0; i < lists.length; i++) {
          removeFrom(lists[i], id)
        }
      })
    }

    const pinSpecs = pins.map(parsePin)

    // Interception uses the ordu inward/outward pipeline (the same mechanism
    // seneca-browser itself uses for `debounce`). This runs for every message
    // regardless of transport, and - unlike `seneca.wrap` - does not depend
    // on the target pin action already existing when the plugin loads (the
    // browser transport client pin is only wired up during transport init).
    //
    // INWARD: on a cacheable read that hits a fresh entry, stop the pipeline
    // and return the cached value - the message never reaches the transport.
    seneca.root.order.inward.add({
      name: 'browser_store_in',
      before: 'inward_msg_modify',
      exec: function (spec) {
        const msg = spec.data.msg
        if (!msg || !matchAny(msg, pinSpecs)) {
          return null
        }
        const clean = cleanMsg(msg, opts.ignore)
        const cls = classify(clean)

        if ('read' === cls.kind) {
          const gid = groupId(clean, cls)
          const hit = store[keyOf(clean, gid)]
          if (hit && !expired(hit)) {
            hit.hits++
            stats.hits++
            msg.store_hit$ = true
            notify()
            return { op: 'stop', out: { kind: 'result', result: clone(hit.value) } }
          }
          return null
        }

        // Optimistic write: mutate the cached list(s) BEFORE the message is
        // sent, and emit the change so views re-render from cache instantly.
        // The write still proceeds to the server; the outward hook reconciles
        // with the authoritative result (or heals on error).
        if ('write' === cls.kind && opts.optimistic) {
          const gid = groupId(clean, cls)
          const metaId = spec.data.meta && spec.data.meta.id
          const isRemove = opts.removeVerbs.indexOf(cls.verb) >= 0
          if (isRemove) {
            const id = msg[opts.idField]
            if (null != id) {
              removeGroup(gid, id)
              stats.optimistic++
              if (null != metaId) {
                pending[metaId] = { gid: gid, op: 'remove' }
              }
              notify()
              emitGroup(gid)
            }
          }
          else if (msg.item && 'object' === typeof msg.item) {
            const entity = clone(msg.item)
            let tmpId = null
            if (null == entity[opts.idField]) {
              tmpId = '__opt_' + ++tmpSeq
              entity[opts.idField] = tmpId
            }
            upsertGroup(gid, entity, null)
            stats.optimistic++
            if (null != metaId) {
              pending[metaId] = { gid: gid, op: 'upsert', tmpId: tmpId }
            }
            notify()
            emitGroup(gid)
          }
        }
        return null
      },
    })

    // OUTWARD: on the reply, cache a successful read result (a miss that went
    // through) and invalidate the group on a successful write.
    seneca.root.order.outward.add({
      name: 'browser_store_out',
      exec: function (spec) {
        const msg = spec.data.msg
        if (!msg || true === msg.store_hit$ || !matchAny(msg, pinSpecs)) {
          return null
        }
        const err = spec.data.err || (spec.data.meta && spec.data.meta.error)
        const out = spec.data.out
        const clean = cleanMsg(msg, opts.ignore)
        const cls = classify(clean)
        if ('read' === cls.kind) {
          stats.misses++
          const gid = groupId(clean, cls)
          if (!err && cacheable(out)) {
            setEntry(keyOf(clean, gid), gid, clean, clone(out))
          }
          notify()
        }
        else if ('write' === cls.kind) {
          const gid = groupId(clean, cls)
          const metaId = spec.data.meta && spec.data.meta.id
          const p = metaId != null ? pending[metaId] : null
          if (metaId != null) {
            delete pending[metaId]
          }

          if (err) {
            // Heal: the optimistic guess may be wrong, so drop the group and
            // let views re-fetch the authoritative state.
            invalidateGroup(gid)
            stats.invalidations++
            notify()
            emitGroup(gid)
            return null
          }

          if (!opts.optimistic) {
            // Non-optimistic mode: invalidate-on-write.
            invalidateGroup(gid)
            stats.invalidations++
            notify()
            emitGroup(gid)
            return null
          }

          // Reconcile the optimistic mutation with the authoritative result.
          const auth = out && out.item ? out.item : null
          if (p && 'upsert' === p.op) {
            if (auth) {
              // Replace the temp-id row (create) or the optimistic row
              // (update) with the server's authoritative entity.
              upsertGroup(gid, auth, p.tmpId)
              emitGroup(gid)
            }
            else if (p.tmpId) {
              // Created but no authoritative entity returned - refetch to get
              // the real id.
              invalidateGroup(gid)
              stats.invalidations++
              emitGroup(gid)
            }
            notify()
          }
          else if (p && 'remove' === p.op) {
            // Already removed optimistically; nothing to reconcile.
            notify()
          }
          else {
            // No optimistic step ran (e.g. a write without an item payload):
            // apply the authoritative entity if present, else refetch.
            if (auth) {
              upsertGroup(gid, auth, null)
            }
            else {
              invalidateGroup(gid)
              stats.invalidations++
            }
            notify()
            emitGroup(gid)
          }
        }
        return null
      },
    })

    // ---- control messages ------------------------------------------------

    // Reactivity, as Seneca messages: whenever cached data changes the store
    // emits a change event that any component can `sub` to (many observers).
    // `changed:group` names the affected group; `changed:all` signals a wipe.
    // These are plain acts with no-op sink handlers so `sub` can observe them
    // (a bare act with no matching action would not reach subscribers).
    seneca.add('sys:browser-store,changed:group', function (msg, reply) {
      reply()
    })
    seneca.add('sys:browser-store,changed:all', function (msg, reply) {
      reply()
    })

    function emitGroup(gid) {
      seneca.act('sys:browser-store,changed:group', { group: gid })
    }
    function emitAll() {
      seneca.act('sys:browser-store,changed:all', {})
    }

    seneca.add('sys:browser-store,get:state', function (msg, reply) {
      reply({ ok: true, state: tree(), stats: Object.assign({}, stats), entries: order.length })
    })
    seneca.add('sys:browser-store,get:stats', function (msg, reply) {
      reply({ ok: true, stats: Object.assign({}, stats), entries: order.length })
    })
    seneca.add('sys:browser-store,clear:store', function (msg, reply) {
      clearAll()
      notify()
      emitAll()
      reply({ ok: true })
    })
    seneca.add('sys:browser-store,invalidate:group', function (msg, reply) {
      const gid = String(msg.group)
      const n = invalidateGroup(gid)
      notify()
      emitGroup(gid)
      reply({ ok: true, invalidated: n })
    })

    const api = {
      state: tree,
      entries: function () {
        return order.length
      },
      stats: function () {
        return Object.assign({}, stats)
      },
      clear: function () {
        clearAll()
        notify()
        emitAll()
      },
      invalidate: function (gid) {
        const g = String(gid)
        const n = invalidateGroup(g)
        notify()
        emitGroup(g)
        return n
      },
      subscribe: function (fn) {
        listeners.push(fn)
        return function () {
          const i = listeners.indexOf(fn)
          if (i >= 0) {
            listeners.splice(i, 1)
          }
        }
      },
      config: function () {
        return {
          pins: pins.slice(),
          read: opts.read.slice(),
          write: opts.write.slice(),
          zoneKey: opts.zoneKey,
          ttl: opts.ttl,
          max: opts.max,
          optimistic: opts.optimistic,
          idField: opts.idField,
        }
      },
    }

    return {
      name: 'browser-store',
      exports: {
        api: api,
      },
    }
  }

  // ---- helpers -----------------------------------------------------------

  function asArray(v) {
    if (null == v) {
      return []
    }
    return Array.isArray(v) ? v.slice() : [v]
  }

  // Parse a pin string like 'aim:*' or 'a:1,b:2' into a spec object. A '*'
  // value means "key present, any value" (stored as boolean true).
  function parsePin(pin) {
    const spec = {}
    const parts = String(pin).split(',')
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      const idx = p.indexOf(':')
      if (idx < 0) {
        continue
      }
      const k = p.slice(0, idx).trim()
      const v = p.slice(idx + 1).trim()
      if (k) {
        spec[k] = '*' === v ? true : v
      }
    }
    return spec
  }

  function matchPin(msg, spec) {
    for (const k in spec) {
      if (!Object.prototype.hasOwnProperty.call(msg, k)) {
        return false
      }
      if (true !== spec[k] && String(msg[k]) !== spec[k]) {
        return false
      }
    }
    return true
  }

  function matchAny(msg, specs) {
    for (let i = 0; i < specs.length; i++) {
      if (matchPin(msg, specs[i])) {
        return true
      }
    }
    return false
  }

  function now() {
    return typeof Date !== 'undefined' ? Date.now() : 0
  }

  // Copy a message without Seneca control markers ($-suffixed keys) and
  // without ignored keys.
  function cleanMsg(msg, ignore) {
    const out = {}
    if (!msg || 'object' !== typeof msg) {
      return out
    }
    const keys = Object.keys(msg)
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      if ('$' === k.charAt(k.length - 1)) {
        continue
      }
      if (ignore.indexOf(k) >= 0) {
        continue
      }
      const v = msg[k]
      if ('function' === typeof v) {
        continue
      }
      out[k] = v
    }
    return out
  }

  // Deterministic JSON (sorted keys) so equal queries produce equal keys.
  function stableStringify(v) {
    const seen = []
    function walk(x) {
      if (null === x || 'object' !== typeof x) {
        return x
      }
      if (seen.indexOf(x) >= 0) {
        return '[Circular]'
      }
      seen.push(x)
      let out
      if (Array.isArray(x)) {
        out = x.map(walk)
      }
      else {
        out = {}
        const keys = Object.keys(x).sort()
        for (let i = 0; i < keys.length; i++) {
          out[keys[i]] = walk(x[keys[i]])
        }
      }
      seen.pop()
      return out
    }
    try {
      return JSON.stringify(walk(v))
    }
    catch (e) {
      return String(v)
    }
  }

  // A short human-readable label: scalar msg props as `k:v,...`.
  function patternize(clean) {
    const keys = Object.keys(clean)
      .filter(function (k) {
        return 'object' !== typeof clean[k]
      })
      .sort()
    return keys
      .map(function (k) {
        return k + ':' + clean[k]
      })
      .join(',')
  }

  function clone(v) {
    if (null == v || 'object' !== typeof v) {
      return v
    }
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(v)
      }
      catch (e) {
        // fall through to JSON clone
      }
    }
    try {
      return JSON.parse(JSON.stringify(v))
    }
    catch (e) {
      return v
    }
  }

  return browser_store
})

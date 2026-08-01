// Type declarations for @seneca/browser-store.

export interface BrowserStoreOptions {
  /** Pins to intercept (should match the remote client pin). Default 'aim:*'. */
  pin?: string | string[]
  /** Message keys whose presence marks a cacheable read. */
  read?: string[]
  /** Message keys whose presence marks an invalidating write. */
  write?: string[]
  /** Key holding the zone/namespace, used in the group id. Default 'aim'. */
  zoneKey?: string
  /** Per-entry time-to-live in ms (null = rely on write-invalidation). */
  ttl?: number | null
  /** Max cached entries (oldest evicted first). Default 500. */
  max?: number
  /** Message keys never included in the cache key. Default ['gateway$']. */
  ignore?: string[]
  /** Update cached lists in place on write (vs invalidate). Default true. */
  optimistic?: boolean
  /** Entity identity field for optimistic upsert/remove. Default 'id'. */
  idField?: string
  /** Keys inside a cached value holding entity arrays. Default ['list','items']. */
  listFields?: string[]
  /** Write verbs treated as deletions. Default ['remove','delete']. */
  removeVerbs?: string[]
}

export interface StoreEntry {
  label: string
  query: Record<string, any>
  value: any
  at: number
  age: number
  hits: number
  stale: boolean
}

export interface StoreGroup {
  count: number
  entries: StoreEntry[]
}

export type StoreTree = Record<string, StoreGroup>

export interface StoreStats {
  hits: number
  misses: number
  sets: number
  invalidations: number
  evictions: number
  optimistic: number
}

export interface BrowserStoreApi {
  /** The Redux-like state tree, grouped by zone/entity. */
  state(): StoreTree
  /** Number of cached entries. */
  entries(): number
  /** Cache statistics. */
  stats(): StoreStats
  /** Empty the whole cache. */
  clear(): void
  /** Invalidate one group; returns the number of entries removed. */
  invalidate(group: string): number
  /** Subscribe to cache changes; returns an unsubscribe function. */
  subscribe(fn: () => void): () => void
  /** The resolved configuration. */
  config(): {
    pins: string[]
    read: string[]
    write: string[]
    zoneKey: string
    ttl: number | null
    max: number
  }
}

/** The Seneca plugin. Register with `seneca.use(BrowserStore, opts)` AFTER `.client(...)`. */
declare function browser_store(options?: BrowserStoreOptions): any

export default browser_store

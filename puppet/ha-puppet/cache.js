// In-memory screenshot cache backing the `fromcacheifyounger` parameter.
//
// Entries are keyed by the JSON of the exact request parameters that shape the
// rendered image (see RequestHandler). Only requests that opt in via
// `fromcacheifyounger` ever reach put(), so no memory is used for plain
// screenshot traffic.
//
// The cache is bounded by total image bytes (LRU eviction) rather than entry
// count: a single 4000x4000 24-bit BMP is ~48 MB, so a count-based cache would
// not meaningfully cap memory.
const MAX_CACHE_BYTES = 64 * 1024 * 1024; // 64 MB

export class ScreenshotCache {
  // capacityBytes: expose for tests; production uses MAX_CACHE_BYTES.
  constructor(capacityBytes = MAX_CACHE_BYTES) {
    this.capacityBytes = capacityBytes;
    this.map = new Map(); // key -> { image: Buffer, createdAt: number }
    this.currentBytes = 0;
  }

  has(key) {
    return this.map.has(key);
  }

  get(key) {
    const entry = this.map.get(key);
    if (entry) {
      // Refresh recency (LRU) without changing the entry's timestamp
      this.map.delete(key);
      this.map.set(key, entry);
    }
    return entry;
  }

  put(key, image) {
    const existing = this.map.get(key);
    if (existing) {
      this.map.delete(key);
      this.currentBytes -= existing.image.length;
    }
    if (image.length > this.capacityBytes) {
      // A single entry larger than the whole cache is not cached
      return;
    }
    if (this.currentBytes + image.length > this.capacityBytes) {
      // Evict least-recently-used entries until the new entry fits
      for (const [evictKey, evicted] of this.map) {
        this.map.delete(evictKey);
        this.currentBytes -= evicted.image.length;
        if (this.currentBytes + image.length <= this.capacityBytes) {
          break;
        }
      }
    }
    this.map.set(key, { image, createdAt: Date.now() });
    this.currentBytes += image.length;
  }

  // Test helper: age an entry so freshness checks can be exercised without
  // waiting real seconds.
  _ageEntry(key, ms) {
    const entry = this.map.get(key);
    if (entry) {
      entry.createdAt -= ms;
    }
  }
}

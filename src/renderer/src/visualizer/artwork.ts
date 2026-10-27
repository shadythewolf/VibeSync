/**
 * Album artwork image cache. Artwork arrives as a data: URL (already cached on disk by the
 * main process); we decode it once per key and keep a small LRU of HTMLImageElements so
 * switching modes or tracks back and forth never re-decodes.
 */
const MAX_ENTRIES = 12
const cache = new Map<string, Promise<HTMLImageElement>>()

export function loadArtwork(key: string, url: string): Promise<HTMLImageElement> {
  const hit = cache.get(key)
  if (hit) {
    // refresh LRU order
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      // decode() makes the first draw cheap
      if (typeof img.decode === 'function') {
        img.decode().then(() => resolve(img), () => resolve(img))
      } else resolve(img)
    }
    img.onerror = () => {
      cache.delete(key)
      reject(new Error('artwork decode failed'))
    }
    img.src = url
  })
  cache.set(key, p)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return p
}

export function clearArtworkCache(): void {
  cache.clear()
}

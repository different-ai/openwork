import { randomUUID } from "node:crypto"

/**
 * Generation-keyed read-through cache.
 *
 * Every entry key embeds the current generation of its scope (for example one
 * organization). Invalidating the scope writes a new generation, so all of its
 * entries become unreachable in one O(1) write, with no key scan.
 *
 * The generation is read before the loader runs. A loader that read the
 * database before a write committed therefore stores its stale result under the
 * old generation, where no reader looks once the write has bumped it. Plain
 * delete-then-repopulate caches cannot close that window.
 *
 * Kept free of database and environment imports so it can be unit tested.
 */

export type GenerationCacheRedis = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>
  /** Reads the generation and its entries in one round trip; without it, each is its own GET. */
  mget?(...keys: string[]): Promise<Array<string | null>>
}

export type GenerationCacheEntry<T> = {
  entryKey: (generation: string) => string
  parse: (raw: string | null) => T | null
  load: () => Promise<T>
}

/**
 * Generations live far longer than any entry. When a generation key expires,
 * readers fall back to INITIAL_GENERATION; entries written under it before the
 * first bump expired long ago, so nothing stale can be resurrected.
 */
export const GENERATION_TTL_SECONDS = 24 * 60 * 60
const INITIAL_GENERATION = "0"

/**
 * The generation this process last read for each scope. It only chooses which
 * entry keys to fetch together with the generation; an entry is used only when
 * the generation read in that same MGET matches it, so a stale guess costs one
 * more round trip and never serves stale data.
 */
const lastReadGenerations = new Map<string, string>()

export async function readThroughGeneration<T>(input: {
  redis: GenerationCacheRedis | null
  generationKey: string
  entryKey: (generation: string) => string
  /** Must stay well below GENERATION_TTL_SECONDS. */
  ttlSeconds: number
  parse: (raw: string | null) => T | null
  load: () => Promise<T>
  onError?: (stage: "get" | "set", error: unknown) => void
}): Promise<T> {
  const [value] = await readManyThroughGeneration<[T]>({ ...input, entries: [input] })
  return value
}

/**
 * Several entries of one scope. With MGET and an unchanged generation, the
 * generation and every entry come back in one round trip; after a bump, a
 * second round trip reads the entries under the new generation.
 */
export async function readManyThroughGeneration<T extends unknown[]>(input: {
  redis: GenerationCacheRedis | null
  generationKey: string
  entries: { [K in keyof T]: GenerationCacheEntry<T[K]> }
  /** Must stay well below GENERATION_TTL_SECONDS. */
  ttlSeconds: number
  onError?: (stage: "get" | "set", error: unknown) => void
}): Promise<T> {
  const { redis } = input
  const entries = input.entries as readonly GenerationCacheEntry<unknown>[]
  if (!redis) {
    return Promise.all(entries.map((entry) => entry.load())) as Promise<T>
  }

  const values: unknown[] = entries.map(() => null)
  const parse = (index: number, raw: string | null) => {
    try {
      values[index] = entries[index].parse(raw)
    } catch (error) {
      input.onError?.("get", error)
    }
  }
  // Resolved before loading: see the race note at the top of this file.
  let generation: string | null = null
  try {
    const guess = lastReadGenerations.get(input.generationKey) ?? INITIAL_GENERATION
    let fetchedAt: string | null = null
    if (redis.mget) {
      const [current, ...raws] = await redis.mget(input.generationKey, ...entries.map((entry) => entry.entryKey(guess)))
      generation = current ?? INITIAL_GENERATION
      if (generation === guess) {
        raws.forEach((raw, index) => parse(index, raw))
        fetchedAt = generation
      }
    } else {
      generation = (await redis.get(input.generationKey)) ?? INITIAL_GENERATION
    }
    lastReadGenerations.set(input.generationKey, generation)
    if (fetchedAt !== generation) {
      const keys = entries.map((entry) => entry.entryKey(generation as string))
      const raws = redis.mget ? await redis.mget(...keys) : await Promise.all(keys.map((key) => redis.get(key)))
      raws.forEach((raw, index) => parse(index, raw))
    }
  } catch (error) {
    input.onError?.("get", error)
  }

  await Promise.all(entries.map(async (entry, index) => {
    if (values[index] !== null) return
    const loaded = await entry.load()
    values[index] = loaded
    // Without a known generation the entry could land under a stale one; skip the write.
    if (generation === null) return
    try {
      await redis.set(entry.entryKey(generation), JSON.stringify(loaded), "EX", input.ttlSeconds)
    } catch (error) {
      input.onError?.("set", error)
    }
  }))
  return values as T
}

/** Makes every entry in the scope unreachable. Call only after the source rows have committed. */
export async function bumpGeneration(redis: GenerationCacheRedis, generationKey: string) {
  await redis.set(generationKey, randomUUID(), "EX", GENERATION_TTL_SECONDS)
}

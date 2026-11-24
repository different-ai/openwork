import { randomUUID } from "node:crypto"

export type GenerationCacheRedis = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>
  mget?(...keys: string[]): Promise<Array<string | null>>
}

export type GenerationCacheEntry<T> = {
  entryKey: (generation: string) => string
  parse: (raw: string | null) => T | null
  load: () => Promise<T>
}

export const GENERATION_TTL_SECONDS = 24 * 60 * 60
const INITIAL_GENERATION = "0"

const lastReadGenerations = new Map<string, string>()

export async function readThroughGeneration<T>(input: {
  redis: GenerationCacheRedis | null
  generationKey: string
  entryKey: (generation: string) => string
  ttlSeconds: number
  parse: (raw: string | null) => T | null
  load: () => Promise<T>
  onError?: (stage: "get" | "set", error: unknown) => void
}): Promise<T> {
  const [value] = await readManyThroughGeneration<[T]>({ ...input, entries: [input] })
  return value
}

export async function readManyThroughGeneration<T extends unknown[]>(input: {
  redis: GenerationCacheRedis | null
  generationKey: string
  entries: { [K in keyof T]: GenerationCacheEntry<T[K]> }
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
    if (generation === null) return
    try {
      await redis.set(entry.entryKey(generation), JSON.stringify(loaded), "EX", input.ttlSeconds)
    } catch (error) {
      input.onError?.("set", error)
    }
  }))
  return values as T
}

export async function bumpGeneration(redis: GenerationCacheRedis, generationKey: string) {
  await redis.set(generationKey, randomUUID(), "EX", GENERATION_TTL_SECONDS)
}

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const resourceSchema = z.object({
  html: z.string().max(768 * 1024),
  csp: z.object({ connectDomains: z.array(z.string()), resourceDomains: z.array(z.string()),
    frameDomains: z.array(z.string()), baseUriDomains: z.array(z.string()) }),
  prefersBorder: z.boolean(),
});
export type CachedMcpAppResource = z.infer<typeof resourceSchema>;
const storedSchema = z.object({ savedAt: z.number(), digest: z.string(), resource: resourceSchema });
const MAX_BYTES = 16 * 1024 * 1024;
const TTL_MS = 24 * 60 * 60_000;
const digest = (resource: CachedMcpAppResource) => createHash("sha256").update(JSON.stringify(resource)).digest("hex");

/** Content only: credentials, tool definitions, permissions and launch leases are never cached. */
export function createMcpAppResourceCache(directory: string, now = Date.now) {
  const memory = new Map<string, z.infer<typeof storedSchema>>();
  // Sized once on insert: a hit must not re-serialize every cached App.
  const sizes = new Map<string, number>();
  const remember = (key: string, value: z.infer<typeof storedSchema>) => {
    memory.delete(key); memory.set(key, value);
    if (!sizes.has(key)) sizes.set(key, Buffer.byteLength(JSON.stringify(value)));
    trimMemory();
  };
  const pending = new Map<string, Promise<CachedMcpAppResource>>();
  let maintenance = Promise.resolve();
  const trimMemory = () => {
    let bytes = 0;
    for (const [key, value] of [...memory].reverse()) {
      bytes += sizes.get(key) ?? 0;
      if (bytes > MAX_BYTES || now() - value.savedAt >= TTL_MS) { memory.delete(key); sizes.delete(key); }
    }
  };
  const trimDisk = async () => {
    const files = await Promise.all((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(async name => ({ path: join(directory, name), info: await stat(join(directory, name)) })));
    let bytes = 0;
    for (const file of files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)) {
      bytes += file.info.size;
      if (bytes > MAX_BYTES || now() - file.info.mtimeMs >= TTL_MS) await rm(file.path);
    }
  };
  return {
    async read(scope: string, uri: string, load: () => Promise<CachedMcpAppResource>): Promise<CachedMcpAppResource> {
      const key = createHash("sha256").update(JSON.stringify([scope, uri])).digest("hex");
      const existing = pending.get(key);
      if (existing) return structuredClone(await existing);
      const request = (async () => {
        let stored = memory.get(key);
        if (!stored) {
          const raw: unknown = await readFile(join(directory, `${key}.json`), "utf8").then(text => JSON.parse(text)).catch(() => null);
          const parsed = storedSchema.safeParse(raw);
          if (parsed.success) stored = parsed.data;
        }
        if (stored && now() - stored.savedAt < TTL_MS && digest(stored.resource) === stored.digest) {
          remember(key, stored);
          return stored.resource;
        }
        const resource = resourceSchema.parse(await load());
        const value = { savedAt: now(), digest: digest(resource), resource };
        sizes.delete(key); remember(key, value);
        // A full disk, corrupt entry or failed cache write must never prevent an App opening.
        maintenance = maintenance.then(async () => {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeFile(join(directory, `${key}.json`), JSON.stringify(value), { mode: 0o600 });
          await trimDisk();
        }).catch(() => undefined);
        await maintenance;
        return resource;
      })();
      pending.set(key, request);
      try { return structuredClone(await request); }
      finally { pending.delete(key); }
    },
  };
}

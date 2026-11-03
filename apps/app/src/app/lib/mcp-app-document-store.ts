/**
 * Saved App documents. Each is over half a megabyte, so they live in IndexedDB
 * and leave the small localStorage budget to saved results. They are a
 * convenience: any failure here only means an App opens the ordinary way.
 */
const DATABASE = "openwork-mcp-app-documents";
const DOCUMENTS = "documents";
const SIZES = "sizes";
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export type McpAppDocumentSize = { key: string; bytes: number; savedAt: number };

export type McpAppDocumentBackend = {
  read(key: string): Promise<string | null>;
  save(html: string, size: McpAppDocumentSize): Promise<void>;
  sizes(): Promise<McpAppDocumentSize[]>;
  remove(keys: string[]): Promise<void>;
  clear(): Promise<void>;
};

const answer = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const finished = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = transaction.onerror = () => reject(transaction.error);
});

function indexedDbBackend(): McpAppDocumentBackend {
  let opened: Promise<IDBDatabase> | null = null;
  const database = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(DOCUMENTS);
        request.result.createObjectStore(SIZES, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((cause: unknown) => {
      opened = null;
      throw cause;
    });
    return opened;
  };
  return {
    async read(key) {
      const value: unknown = await answer((await database()).transaction(DOCUMENTS).objectStore(DOCUMENTS).get(key));
      return typeof value === "string" ? value : null;
    },
    async save(html, size) {
      const transaction = (await database()).transaction([DOCUMENTS, SIZES], "readwrite");
      transaction.objectStore(DOCUMENTS).put(html, size.key);
      transaction.objectStore(SIZES).put(size);
      await finished(transaction);
    },
    async sizes() {
      return await answer((await database()).transaction(SIZES).objectStore(SIZES).getAll());
    },
    async remove(keys) {
      const transaction = (await database()).transaction([DOCUMENTS, SIZES], "readwrite");
      for (const key of keys) {
        transaction.objectStore(DOCUMENTS).delete(key);
        transaction.objectStore(SIZES).delete(key);
      }
      await finished(transaction);
    },
    async clear() {
      const transaction = (await database()).transaction([DOCUMENTS, SIZES], "readwrite");
      transaction.objectStore(DOCUMENTS).clear();
      transaction.objectStore(SIZES).clear();
      await finished(transaction);
    },
  };
}

let backend = indexedDbBackend();

/** For tests, which have no IndexedDB. */
export function setMcpAppDocumentBackend(next: McpAppDocumentBackend): void {
  backend = next;
}

const documentKey = (scopeKey: string, entryId: string) => JSON.stringify([scopeKey, entryId]);

async function trim(now: number) {
  const sizes = (await backend.sizes()).sort((left, right) => right.savedAt - left.savedAt);
  let bytes = 0;
  const excess = sizes.filter((size) => {
    bytes += size.bytes;
    return bytes > MAX_BYTES || now - size.savedAt >= MAX_AGE_MS;
  });
  if (excess.length) await backend.remove(excess.map((size) => size.key));
}

export const mcpAppDocuments = {
  async read(scopeKey: string, entryId: string): Promise<string | null> {
    return await backend.read(documentKey(scopeKey, entryId)).catch(() => null);
  },
  async save(scopeKey: string, entryId: string, html: string, now = Date.now()): Promise<void> {
    await backend.save(html, { key: documentKey(scopeKey, entryId), bytes: new Blob([html]).size, savedAt: now })
      .then(() => trim(now)).catch(() => undefined);
  },
  async remove(scopeKey: string, entryId: string): Promise<void> {
    await backend.remove([documentKey(scopeKey, entryId)]).catch(() => undefined);
  },
  /** Sign-out: another account on this profile must not find them. */
  async clear(): Promise<void> {
    await backend.clear().catch(() => undefined);
  },
};

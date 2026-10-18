import type { WorkbotCorrectionReference, WorkbotViewContext } from "@openwork/types/workbot-context";
import type { WorkbotAttachment, WorkbotFile } from "./data";

export type Upload = {
  key: string;
  file: File;
  previewUrl: string | null;
  loaded: number;
  status: "uploading" | "done" | "failed";
  error: string | null;
  saved: WorkbotFile | null;
};

export type Pending = {
  id: string;
  text: string;
  context?: WorkbotViewContext;
  sentAt: number;
  uploads: Upload[];
  attachments: WorkbotAttachment[];
  /** A correction is appended; it never removes the original conversation. */
  correctionOf?: string;
  correctionReference?: WorkbotCorrectionReference;
  failed: string | null;
};

type Snapshot = { text: string; uploads: Upload[]; pending: Pending[] };
type Uploader = (file: File, progress: (loaded: number) => void, signal: AbortSignal) => Promise<WorkbotFile>;
type Sender = (entry: Pending, attachments: string[]) => Promise<unknown>;

/** One owner per identity and chat, above keyed screens. Files, progress and send identity travel together. */
export function createComposerState(uploadFile: Uploader) {
  let state: Snapshot = { text: "", uploads: [], pending: [] };
  const listeners = new Set<() => void>();
  const waiters = new Map<string, { promise: Promise<WorkbotFile | null>; controller: AbortController }>();
  const sending = new Set<string>();
  const previewUrls = new Set<string>();
  const publish = (next: Snapshot) => { state = next; for (const listener of listeners) listener(); };
  const updateUpload = (key: string, patch: Partial<Upload>) => {
    const update = (uploads: Upload[]) => uploads.map(upload => upload.key === key ? { ...upload, ...patch } : upload);
    publish({ ...state, uploads: update(state.uploads), pending: state.pending.map(entry => ({ ...entry, uploads: update(entry.uploads) })) });
  };
  const start = (upload: Upload) => {
    if (upload.saved || waiters.has(upload.key)) return;
    const controller = new AbortController();
    updateUpload(upload.key, { status: "uploading", error: null, loaded: 0 });
    const promise = uploadFile(upload.file, loaded => updateUpload(upload.key, { loaded }), controller.signal)
      .then(saved => { updateUpload(upload.key, { status: "done", saved, loaded: upload.file.size }); return saved; })
      .catch((error: unknown) => {
        updateUpload(upload.key, { status: "failed", error: error instanceof Error ? error.message : "Couldn't upload." });
        return null;
      });
    waiters.set(upload.key, { promise, controller });
  };
  const release = (upload: Upload) => {
    waiters.get(upload.key)?.controller.abort();
    waiters.delete(upload.key);
    if (upload.previewUrl) { URL.revokeObjectURL(upload.previewUrl); previewUrls.delete(upload.previewUrl); }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setText: (text: string) => publish({ ...state, text }),
    add: (files: FileList | File[]) => {
      const added: Upload[] = Array.from(files).map(file => ({ key: crypto.randomUUID(), file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
        loaded: 0, status: "uploading", error: null, saved: null }));
      for (const upload of added) if (upload.previewUrl) previewUrls.add(upload.previewUrl);
      publish({ ...state, uploads: [...state.uploads, ...added] });
      for (const upload of added) start(upload);
    },
    retryUpload: (key: string) => {
      const upload = state.uploads.find(upload => upload.key === key);
      if (!upload || upload.status !== "failed" || upload.saved) return;
      waiters.delete(key);
      start(upload);
    },
    removeUpload: (key: string) => {
      const upload = state.uploads.find(upload => upload.key === key);
      if (upload) release(upload);
      publish({ ...state, uploads: state.uploads.filter(upload => upload.key !== key) });
    },
    enqueue: (input: { id: string; text: string; context?: WorkbotViewContext; correctionOf?: string; correctionReference?: WorkbotCorrectionReference; attachments?: WorkbotAttachment[] }) => {
      const entry: Pending = { ...input, attachments: input.attachments ?? [], sentAt: Date.now(),
        uploads: input.correctionOf ? [] : state.uploads, failed: null };
      publish({ ...state, ...(input.correctionOf ? {} : { text: "", uploads: [] }), pending: [...state.pending, entry] });
      return entry.id;
    },
    send: async (id: string, sender: Sender, retry = false) => {
      const entry = state.pending.find(entry => entry.id === id);
      if (!entry || sending.has(id)) return;
      sending.add(id);
      publish({ ...state, pending: state.pending.map(entry => entry.id === id ? { ...entry, failed: null } : entry) });
      try {
        if (retry) for (const upload of entry.uploads) {
          // Only explicitly failed uploads retry. Successful ones keep their saved ids, even after send failure.
          if (upload.status !== "failed" || upload.saved) continue;
          waiters.delete(upload.key);
          start(upload);
        }
        const saved = await Promise.all(entry.uploads.map(upload => upload.saved ? Promise.resolve(upload.saved) : waiters.get(upload.key)?.promise ?? Promise.resolve(null)));
        if (!state.pending.some(entry => entry.id === id)) return;
        if (saved.some(file => !file)) throw new Error("A file didn't upload. Send again to retry it.");
        await sender(entry, [...entry.attachments.map(file => file.id), ...saved.flatMap(file => file ? [file.id] : [])]);
      } catch (error: unknown) {
        publish({ ...state, pending: state.pending.map(entry => entry.id === id ? { ...entry, failed: error instanceof Error ? error.message : "That didn't send." } : entry) });
      } finally { sending.delete(id); }
    },
    acknowledge: (ids: ReadonlySet<string>) => {
      if (!state.pending.some(entry => ids.has(entry.id))) return;
      // The conversation can still be using the local preview while its remote thumbnail loads.
      for (const entry of state.pending) if (ids.has(entry.id)) for (const upload of entry.uploads) waiters.delete(upload.key);
      publish({ ...state, pending: state.pending.filter(entry => !ids.has(entry.id)) });
    },
    dispose: () => {
      for (const upload of [...state.uploads, ...state.pending.flatMap(entry => entry.uploads)]) release(upload);
      for (const url of previewUrls) URL.revokeObjectURL(url);
      previewUrls.clear();
      state = { text: "", uploads: [], pending: [] };
      listeners.clear();
    },
  };
}
export type ComposerState = ReturnType<typeof createComposerState>;

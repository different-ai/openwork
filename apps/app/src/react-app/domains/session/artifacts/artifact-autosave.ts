export type ArtifactAutosaveResult = { updatedAt: number };

export type ArtifactAutosaveStatus = "idle" | "debouncing" | "saving" | "conflict" | "error";

export type ArtifactAutosaveSnapshot<T> = {
  value: T;
  baseUpdatedAt: number | null;
  dirty: boolean;
  ready: boolean;
  sourceRevision: number;
  status: ArtifactAutosaveStatus;
  failure: "conflict" | "error" | null;
  error: unknown;
};

type ArtifactAutosaveOptions<T> = {
  initialValue: T;
  initialUpdatedAt: number | null;
  debounceMs?: number;
  equals?: (left: T, right: T) => boolean;
  isConflict: (error: unknown) => boolean;
  write: (value: T, baseUpdatedAt: number | null) => Promise<ArtifactAutosaveResult>;
  onSaved?: (value: T, result: ArtifactAutosaveResult) => void;
};

type InFlight<T> = {
  id: number;
  value: T;
};

const DEFAULT_DEBOUNCE_MS = 600;

export class ArtifactAutosaveController<T> {
  private readonly debounceMs: number;
  private readonly equals: (left: T, right: T) => boolean;
  private readonly isConflict: (error: unknown) => boolean;
  private readonly write: ArtifactAutosaveOptions<T>["write"];
  private readonly onSaved: ArtifactAutosaveOptions<T>["onSaved"];
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: InFlight<T> | null = null;
  private nextWriteId = 1;
  private snapshot: ArtifactAutosaveSnapshot<T>;

  constructor(options: ArtifactAutosaveOptions<T>) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.equals = options.equals ?? Object.is;
    this.isConflict = options.isConflict;
    this.write = options.write;
    this.onSaved = options.onSaved;
    this.snapshot = {
      value: options.initialValue,
      baseUpdatedAt: options.initialUpdatedAt,
      dirty: false,
      ready: false,
      sourceRevision: 0,
      status: "idle",
      failure: null,
      error: null,
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  edit(value: T) {
    if (this.equals(value, this.snapshot.value)) return;

    this.update({ value, dirty: true, ready: true });
    if (this.isStopped()) return;
    if (this.inFlight) {
      this.clearTimer();
      return;
    }
    this.schedule();
  }

  acceptExternal(value: T, updatedAt: number | null) {
    if (this.snapshot.dirty || this.inFlight || this.isStopped()) return false;
    if (
      this.snapshot.ready &&
      typeof this.snapshot.baseUpdatedAt === "number" &&
      typeof updatedAt === "number" &&
      updatedAt < this.snapshot.baseUpdatedAt &&
      this.equals(this.snapshot.value, value)
    ) return false;
    if (
      this.snapshot.ready &&
      this.snapshot.baseUpdatedAt === updatedAt &&
      this.equals(this.snapshot.value, value)
    ) return true;

    this.clearTimer();
    this.update({
      value,
      baseUpdatedAt: updatedAt,
      dirty: false,
      ready: true,
      sourceRevision: this.snapshot.sourceRevision + 1,
      status: "idle",
      failure: null,
      error: null,
    });
    return true;
  }

  applyReload(value: T, updatedAt: number | null) {
    this.clearTimer();
    this.update({
      value,
      baseUpdatedAt: updatedAt,
      dirty: false,
      ready: true,
      sourceRevision: this.snapshot.sourceRevision + 1,
      status: "idle",
      failure: null,
      error: null,
    });
  }

  retry(baseUpdatedAt = this.snapshot.baseUpdatedAt) {
    if (!this.snapshot.dirty || this.inFlight) return;
    this.clearTimer();
    this.update({ baseUpdatedAt });
    this.startWrite(true);
  }

  flush() {
    this.clearTimer();
    if (this.snapshot.dirty && !this.inFlight && !this.isStopped()) {
      this.startWrite();
    }
  }

  dispose() {
    this.flush();
    this.listeners.clear();
  }

  private isStopped() {
    return this.snapshot.failure !== null;
  }

  private schedule() {
    this.clearTimer();
    this.update({ status: "debouncing" });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startWrite();
    }, this.debounceMs);
  }

  private startWrite(retrying = false) {
    if (this.inFlight || !this.snapshot.dirty || (this.isStopped() && !retrying)) return;

    const pending: InFlight<T> = { id: this.nextWriteId, value: this.snapshot.value };
    this.nextWriteId += 1;
    this.inFlight = pending;
    this.update({ status: "saving" });

    void this.write(pending.value, this.snapshot.baseUpdatedAt).then(
      (result) => this.completeWrite(pending, result),
      (error: unknown) => this.failWrite(pending, error),
    );
  }

  private completeWrite(pending: InFlight<T>, result: ArtifactAutosaveResult) {
    if (this.inFlight?.id !== pending.id) return;
    this.inFlight = null;

    if (this.equals(this.snapshot.value, pending.value)) {
      this.update({
        baseUpdatedAt: result.updatedAt,
        dirty: false,
        status: "idle",
        failure: null,
        error: null,
      });
      this.onSaved?.(pending.value, result);
      return;
    }

    this.update({ baseUpdatedAt: result.updatedAt, dirty: true, status: "idle", failure: null, error: null });
    this.startWrite();
  }

  private failWrite(pending: InFlight<T>, error: unknown) {
    if (this.inFlight?.id !== pending.id) return;
    this.inFlight = null;
    const failure = this.isConflict(error) ? "conflict" : "error";
    this.update({
      dirty: true,
      status: failure,
      failure,
      error,
    });
  }

  private clearTimer() {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private update(patch: Partial<ArtifactAutosaveSnapshot<T>>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

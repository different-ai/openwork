type WorkWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

type WorkBatch<Value> = {
  value: Value;
  waiters: WorkWaiter[];
};

type ActiveWork<Value> = {
  trailing: WorkBatch<Value> | null;
};

export class LatestTrailingWorkQueue<Key, Value> {
  private readonly activeByKey = new Map<Key, ActiveWork<Value>>();
  private readonly run: (value: Value) => Promise<void>;
  private readonly logDetachedError: (key: Key, error: unknown) => void;

  constructor(
    run: (value: Value) => Promise<void>,
    logDetachedError: (key: Key, error: unknown) => void,
  ) {
    this.run = run;
    this.logDetachedError = logDetachedError;
  }

  enqueue(key: Key, value: Value): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const active = this.activeByKey.get(key);
      if (active) {
        if (active.trailing) {
          active.trailing.value = value;
          active.trailing.waiters.push(waiter);
        } else {
          active.trailing = { value, waiters: [waiter] };
        }
        return;
      }

      const next: ActiveWork<Value> = { trailing: null };
      this.activeByKey.set(key, next);
      void this.drain(key, next, { value, waiters: [waiter] }).catch((error) => {
        this.logDetachedError(key, error);
      });
    });
  }

  private async drain(key: Key, active: ActiveWork<Value>, firstBatch: WorkBatch<Value>): Promise<void> {
    let batch: WorkBatch<Value> | null = firstBatch;
    while (batch) {
      try {
        await this.run(batch.value);
        for (const waiter of batch.waiters) waiter.resolve();
      } catch (error) {
        for (const waiter of batch.waiters) waiter.reject(error);
      }
      batch = active.trailing;
      active.trailing = null;
    }
    if (this.activeByKey.get(key) === active) this.activeByKey.delete(key);
  }
}

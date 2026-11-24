export interface EventuallyOptions<T> {
  within: number;
  intervalMs?: number;
  label?: string;
  until?: (value: T) => boolean;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

export async function eventually<T>(
  probe: () => Promise<T> | T,
  options: EventuallyOptions<T>,
): Promise<T> {
  const intervalMs = options.intervalMs ?? 500;
  const until = options.until ?? ((value: T) => Boolean(value));
  const deadline = Date.now() + options.within;
  let lastValue: T | undefined;
  let lastError: unknown;
  let hasValue = false;

  while (true) {
    try {
      lastValue = await probe();
      hasValue = true;
      lastError = undefined;
      if (until(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const label = options.label ?? "condition";
      const valueDetail = hasValue ? `; last value: ${describe(lastValue)}` : "";
      const errorDetail = lastError === undefined ? "" : `; last error: ${describe(lastError instanceof Error ? lastError.message : lastError)}`;
      throw new Error(`Timed out waiting for ${label} after ${options.within}ms${valueDetail}${errorDetail}`);
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}

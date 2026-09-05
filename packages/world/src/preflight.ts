export interface PreflightCheck {
  id: string;
  label: string;
  run(): Promise<{ ok: boolean; detail?: string; hint?: string }>;
}

export type PreflightResult = {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
  hint?: string;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runOne(check: PreflightCheck, timeoutMs: number): Promise<PreflightResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: false; detail: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, detail: "timed out" }), timeoutMs);
    timer.unref();
  });
  try {
    const result = await Promise.race([
      check.run().catch((error: unknown) => ({ ok: false, detail: errorText(error) })),
      timeout,
    ]);
    return { id: check.id, label: check.label, ...result };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function runPreflight(
  checks: PreflightCheck[],
  timeoutMs = 5_000,
): Promise<PreflightResult[]> {
  return Promise.all(checks.map((check) => runOne(check, timeoutMs)));
}

export function nodeCheck(): PreflightCheck {
  return {
    id: "node",
    label: "node",
    async run() {
      const major = Number(process.versions.node.split(".", 1)[0]);
      return major >= 24
        ? { ok: true, detail: process.versions.node }
        : { ok: false, detail: `Node ${process.versions.node}`, hint: "install Node 24 or newer" };
    },
  };
}

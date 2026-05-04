import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { createBoundedOutputCollector, formatRuntimeOutput, type RuntimeOutputSnapshot } from "../../runtime/output-buffer.js";

type LocalOpencodeClient = ReturnType<typeof createOpencodeClient>;

export type CreateLocalOpencodeOptions = {
  binary?: string;
  client?: {
    directory?: string;
    fetch?: typeof fetch;
    headers?: Record<string, string>;
    responseStyle?: "data";
    throwOnError?: boolean;
  };
  config?: Record<string, unknown>;
  cwd?: string;
  env?: Record<string, string | undefined>;
  hostname?: string;
  port?: number;
  signal?: AbortSignal;
  timeout?: number;
};

export type LocalProcessExit = {
  at: string;
  code: number | null;
  signal: string | null;
};

export type LocalOpencodeHandle = {
  client: LocalOpencodeClient;
  server: {
    close(): void;
    getOutput(): RuntimeOutputSnapshot;
    proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    url: string;
    waitForExit(): Promise<LocalProcessExit>;
  };
};

export class LocalOpencodeStartupError extends Error {
  constructor(
    message: string,
    readonly code: "aborted" | "early_exit" | "missing_binary" | "spawn_failed" | "timeout",
    readonly binary: string,
    readonly output: RuntimeOutputSnapshot,
  ) {
    super(message);
    this.name = "LocalOpencodeStartupError";
  }
}

function normalizeBinary(binary: string | undefined) {
  const value = binary?.trim() ?? "";
  if (!value) {
    throw new LocalOpencodeStartupError(
      "Failed to start OpenCode: no explicit binary path was provided.",
      "missing_binary",
      value,
      { combined: [], stderr: [], stdout: [], totalLines: 0, truncated: false },
    );
  }
  return value;
}

function parseReadinessUrl(line: string) {
  const match = line.match(/https?:\/\/\S+/);
  return match?.[0] ?? null;
}

function buildSpawnErrorMessage(binary: string, error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("ENOENT") || text.includes("executable file not found") || text.includes("No such file")) {
    return `Failed to start OpenCode: executable not found at ${binary}`;
  }
  return `Failed to start OpenCode from ${binary}: ${text}`;
}

export async function createLocalOpencode(options: CreateLocalOpencodeOptions = {}): Promise<LocalOpencodeHandle> {
  const binary = normalizeBinary(options.binary);
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 4096;
  const timeoutMs = options.timeout ?? 5_000;
  let resolveReady: ((url: string) => void) | null = null;
  const output = createBoundedOutputCollector({
    maxBytes: 16_384,
    maxLines: 200,
    onLine(line) {
      const readinessUrl = parseReadinessUrl(line.text);
      if (readinessUrl && /listening/i.test(line.text)) {
        resolveReady?.(readinessUrl);
      }
    },
  });

  const args = [
    binary,
    "serve",
    `--hostname=${hostname}`,
    `--port=${port}`,
  ];

  if (typeof options.config?.logLevel === "string" && options.config.logLevel.trim()) {
    args.push(`--log-level=${options.config.logLevel.trim()}`);
  }

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config ?? {}),
      },
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    });
  } catch (error) {
    throw new LocalOpencodeStartupError(buildSpawnErrorMessage(binary, error), "spawn_failed", binary, output.snapshot());
  }

  let settled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;

  const waitForExit = async (): Promise<LocalProcessExit> => {
    const code = await proc.exited;
    return {
      at: new Date().toISOString(),
      code,
      signal: "signalCode" in proc && typeof proc.signalCode === "string" ? proc.signalCode : null,
    };
  };

  const pump = async (streamName: "stdout" | "stderr", stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) {
      return;
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          output.finish(streamName);
          return;
        }
        const text = decoder.decode(value, { stream: true });
        output.pushChunk(streamName, text);
      }
    } finally {
      output.finish(streamName);
      reader.releaseLock();
    }
  };

  const startup = await new Promise<{ client: LocalOpencodeClient; url: string }>((resolve, reject) => {
    const rejectOnce = (error: LocalOpencodeStartupError) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (abortListener && options.signal) {
        options.signal.removeEventListener("abort", abortListener);
      }
      reject(error);
    };

    const resolveOnce = (url: string) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (abortListener && options.signal) {
        options.signal.removeEventListener("abort", abortListener);
      }
      resolve({
        client: createOpencodeClient({
          baseUrl: url,
          directory: options.client?.directory,
          fetch: options.client?.fetch,
          headers: options.client?.headers,
          responseStyle: options.client?.responseStyle ?? "data",
          throwOnError: options.client?.throwOnError ?? true,
        }),
        url,
      });
    };

    resolveReady = resolveOnce;
    void pump("stdout", proc.stdout);
    void pump("stderr", proc.stderr);

    void waitForExit().then((exit) => {
      if (settled) {
        return;
      }

      const snapshot = output.snapshot();
      rejectOnce(
        new LocalOpencodeStartupError(
          `OpenCode exited before becoming ready (${exit.code === null ? "no exit code" : `exit code ${exit.code}`}).\nCollected output:\n${formatRuntimeOutput(snapshot)}`,
          "early_exit",
          binary,
          snapshot,
        ),
      );
    });

    timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }

      proc.kill();
      const snapshot = output.snapshot();
      rejectOnce(
        new LocalOpencodeStartupError(
          `OpenCode did not become ready within ${timeoutMs}ms.\nCollected output:\n${formatRuntimeOutput(snapshot)}`,
          "timeout",
          binary,
          snapshot,
        ),
      );
    }, timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) {
        proc.kill();
        rejectOnce(
          new LocalOpencodeStartupError(
            `OpenCode startup aborted for ${binary}.`,
            "aborted",
            binary,
            output.snapshot(),
          ),
        );
        return;
      }

      abortListener = () => {
        proc.kill();
        rejectOnce(
          new LocalOpencodeStartupError(
            `OpenCode startup aborted for ${binary}.`,
            "aborted",
            binary,
            output.snapshot(),
          ),
        );
      };
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
  }).catch((error) => {
    if (!settled) {
      proc.kill();
    }

    if (error instanceof LocalOpencodeStartupError) {
      throw error;
    }

    throw new LocalOpencodeStartupError(buildSpawnErrorMessage(binary, error), "spawn_failed", binary, output.snapshot());
  });

  return {
    client: startup.client,
    server: {
      close() {
        proc.kill();
      },
      getOutput() {
        return output.snapshot();
      },
      proc,
      url: startup.url,
      waitForExit,
    },
  };
}

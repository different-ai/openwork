export type RuntimeOutputStream = "stdout" | "stderr";

export type RuntimeOutputLine = {
  at: string;
  stream: RuntimeOutputStream;
  text: string;
};

export type RuntimeOutputSnapshot = {
  combined: RuntimeOutputLine[];
  stderr: string[];
  stdout: string[];
  totalLines: number;
  truncated: boolean;
};

type CreateBoundedOutputCollectorOptions = {
  maxBytes?: number;
  maxLines?: number;
  onLine?: (line: RuntimeOutputLine) => void;
};

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

export function createBoundedOutputCollector(options: CreateBoundedOutputCollectorOptions = {}) {
  const maxLines = Math.max(1, options.maxLines ?? 200);
  const maxBytes = Math.max(256, options.maxBytes ?? 16_384);
  const combined: RuntimeOutputLine[] = [];
  const partials: Record<RuntimeOutputStream, string> = {
    stderr: "",
    stdout: "",
  };

  let totalBytes = 0;
  let truncated = false;

  const appendLine = (stream: RuntimeOutputStream, text: string) => {
    const line: RuntimeOutputLine = {
      at: new Date().toISOString(),
      stream,
      text,
    };

    combined.push(line);
    totalBytes += byteLength(text);
    options.onLine?.(line);

    while (combined.length > maxLines || totalBytes > maxBytes) {
      const removed = combined.shift();
      if (!removed) {
        break;
      }
      totalBytes -= byteLength(removed.text);
      truncated = true;
    }
  };

  const flushPartial = (stream: RuntimeOutputStream) => {
    const partial = partials[stream];
    if (!partial) {
      return;
    }
    partials[stream] = "";
    appendLine(stream, partial);
  };

  return {
    finish(stream: RuntimeOutputStream) {
      flushPartial(stream);
    },

    pushChunk(stream: RuntimeOutputStream, chunk: string) {
      if (!chunk) {
        return;
      }

      let buffer = partials[stream] + chunk;
      while (true) {
        const newlineIndex = buffer.search(/\r?\n/);
        if (newlineIndex < 0) {
          break;
        }

        const newlineWidth = buffer[newlineIndex] === "\r" && buffer[newlineIndex + 1] === "\n" ? 2 : 1;
        const line = buffer.slice(0, newlineIndex);
        appendLine(stream, line);
        buffer = buffer.slice(newlineIndex + newlineWidth);
      }

      partials[stream] = buffer;
    },

    snapshot(): RuntimeOutputSnapshot {
      const stdout: string[] = [];
      const stderr: string[] = [];
      for (const line of combined) {
        if (line.stream === "stdout") {
          stdout.push(line.text);
        } else {
          stderr.push(line.text);
        }
      }

      return {
        combined: combined.map((line) => ({ ...line })),
        stderr,
        stdout,
        totalLines: combined.length,
        truncated,
      };
    },
  };
}

export function formatRuntimeOutput(snapshot: RuntimeOutputSnapshot) {
  if (snapshot.combined.length === 0) {
    return "(no child output captured)";
  }

  const lines = snapshot.combined.map((line) => `${line.stream}: ${line.text}`);
  if (snapshot.truncated) {
    lines.unshift("(bounded output buffer truncated older lines)");
  }
  return lines.join("\n");
}

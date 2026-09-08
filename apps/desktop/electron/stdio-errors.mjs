const guardedStreams = new WeakSet();

export function isBrokenPipeError(error) {
  return Boolean(error && typeof error === "object" && error.code === "EPIPE");
}

/**
 * Install once-per-stream error handlers. Only the EventEmitter surface is
 * needed, so tests can pass plain emitters in place of process streams.
 *
 * @param {{ stdout?: NodeJS.EventEmitter, stderr?: NodeJS.EventEmitter }} [streams]
 */
export function installStdioErrorHandlers({ stdout = process.stdout, stderr = process.stderr } = {}) {
  for (const stream of [stdout, stderr]) {
    if (!stream || typeof stream.on !== "function" || guardedStreams.has(stream)) continue;

    stream.on("error", (error) => {
      // The in-process server also listens here. Do not rethrow expected
      // output failures before its handler can disable the failed log sink.
      if (isBrokenPipeError(error) || error?.code === "ERR_STREAM_DESTROYED"
        || error?.code === "ENOSPC" || error?.code === "EDQUOT" || error?.code === "EIO") return;
      throw error;
    });
    guardedStreams.add(stream);
  }
}

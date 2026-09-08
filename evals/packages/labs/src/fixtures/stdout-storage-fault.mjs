import { createServer } from "node:http";
import { installStdioErrorHandlers } from "../../../../../apps/desktop/electron/stdio-errors.mjs";

// Desktop installs its stream guard before starting the in-process server.
installStdioErrorHandlers();

// Preloaded only in the server subprocess: fail request logging without
// filling the host disk or affecting the test runner's own stdout.
const write = process.stdout.write.bind(process.stdout);
const stderrWrite = process.stderr.write.bind(process.stderr);
const stderrFault = process.env.OPENWORK_TEST_STDOUT_STREAM === "stderr";
let stderrFaultInjected = false;
// Optional loopback control lets a journey inject subsequent stream events even
// after the server has correctly stopped attempting stdout writes.
if (process.env.OPENWORK_TEST_STDIO_CONTROL === "1") {
  const control = createServer((request, response) => {
    const [, stream, code] = request.url.split("/");
    if (request.method !== "POST" || !["stdout", "stderr"].includes(stream)
      || !["EIO", "EACCES"].includes(code)) {
      response.writeHead(400).end();
      return;
    }
    response.end("queued", () => setImmediate(() => {
      process[stream].emit("error", Object.assign(new Error(`synthetic-stream-${code}`), { code }));
      stderrWrite(`stdio-control:${stream}:${code}:handled\n`);
    }));
  });
  control.listen(0, "127.0.0.1", () => {
    stderrWrite(`stdio-control-port:${control.address().port}\n`);
    control.unref();
  });
}

process.stdout.write = (...args) => {
  if (process.env.OPENWORK_TEST_STDIO_CONTROL === "1") return write(...args);
  if (!String(args[0]).includes("GET /health 200")) return write(...args);
  if (stderrFault) {
    if (!stderrFaultInjected) {
      stderrFaultInjected = true;
      const code = process.env.OPENWORK_TEST_STDOUT_ERROR;
      stderrWrite(`stderr-storage-fault:${code}\n`);
      process.nextTick(() => process.stderr.emit("error", Object.assign(new Error(`write ${code}`), { code })));
    }
    return write(...args);
  }
  const code = process.env.OPENWORK_TEST_STDOUT_ERROR;
  const error = Object.assign(new Error(`write ${code}`), { code });
  process.stderr.write(`stdout-storage-fault:${code}\n`);
  if (process.env.OPENWORK_TEST_STDOUT_MODE === "sync") throw error;
  process.nextTick(() => process.stdout.emit("error", error));
  return false;
};

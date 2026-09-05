import { installStdioErrorHandlers } from "../../../../../apps/desktop/electron/stdio-errors.mjs";

// Desktop installs its stream guard before starting the in-process server.
installStdioErrorHandlers();

// Preloaded only in the server subprocess: fail request logging without
// filling the host disk or affecting the test runner's own stdout.
const write = process.stdout.write.bind(process.stdout);
const stderrWrite = process.stderr.write.bind(process.stderr);
const stderrFault = process.env.OPENWORK_TEST_STDOUT_STREAM === "stderr";
let stderrFaultInjected = false;
process.stdout.write = (...args) => {
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

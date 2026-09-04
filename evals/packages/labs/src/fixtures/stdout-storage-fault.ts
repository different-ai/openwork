// Preloaded only in the server subprocess: fail request logging without
// filling the host disk or affecting the test runner's own stdout.
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (...args: Parameters<typeof process.stdout.write>) => {
  if (!String(args[0]).includes("GET /health 200")) return write(...args);
  const code = process.env.OPENWORK_TEST_STDOUT_ERROR;
  const error = Object.assign(new Error(`write ${code}`), { code });
  process.stderr.write(`stdout-storage-fault:${code}\n`);
  if (process.env.OPENWORK_TEST_STDOUT_MODE === "sync") throw error;
  process.nextTick(() => process.stdout.emit("error", error));
  return false;
};

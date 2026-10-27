// Embed the worker so a bundled/compiled server does not need the source tree
// beside its executable. Python remains the single authored source.
export { default as computerWorkerSource } from "../computer-x11-worker.py"

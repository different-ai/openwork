import { channel } from "node:diagnostics_channel";

// The desktop subscribes before importing the embedded bundle. Standalone
// servers have no subscriber, sink, timer, or output. Never publish input data.
const events = channel("openwork.desktop.startup-phase");
type StartupPhase = "engine.v2.version-probe" | "engine.version-probe" | "plugin-deps.seed" | "plugin-deps.extract" | "engine.v1.serve" | "engine.v2.resolve" | "engine.v2.serve";

function begin(name: StartupPhase): (failed?: boolean) => void {
  const id = {};
  events.publish({ type: "start", name, id });
  return (failed = false) => events.publish({ type: "end", name, id, failed });
}

export function startupPhaseSync<T>(name: StartupPhase, operation: () => T): T {
  const end = begin(name);
  try { const result = operation(); end(); return result; }
  catch (error) { end(true); throw error; }
}

export async function startupPhase<T>(name: StartupPhase, operation: () => Promise<T>): Promise<T> {
  const end = begin(name);
  try { const result = await operation(); end(); return result; }
  catch (error) { end(true); throw error; }
}

import { reapWindowsBrokerChildren } from "@openwork/child-process/reaper";

// A fresh utility handles cleanup if the launch service crashes. Creating its
// PowerShell/taskkill helpers here never reintroduces admission on UI main.
const parent = Reflect.get(process, "parentPort");
if (!parent) throw new Error("Desktop launch reaper requires its parent port");
parent.once("message", async event => {
  try {
    await reapWindowsBrokerChildren(event.data);
    parent.postMessage({ ok: true });
  } catch {
    // Provider errors can contain command text or paths. The host only needs a
    // bounded clean/unknown result, never those diagnostic payloads.
    parent.postMessage({ ok: false });
  }
});

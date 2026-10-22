import { serveProcessLauncher } from "@openwork/child-process/broker";

// Electron utility processes expose a MessagePort rather than process.send.
// This is a private parent connection; no renderer can construct requests.
const parent = Reflect.get(process, "parentPort");
if (!parent) throw new Error("Desktop launch broker requires its parent port");
serveProcessLauncher({
  send: value => parent.postMessage(value),
  subscribe: receive => parent.on("message", event => receive(event.data)),
  onClose: receive => process.once("exit", receive),
});

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TeachButton, WorkbotTeaching } from "../../../packages/workbot-ui/src/teaching";
import { setWorkbotHost } from "../../../packages/workbot-ui/src/host";
import "../src/client/styles.css";

// Bounded production-component harness: only the teaching API is replaced.
// Two independently mounted windows exercise React's per-instance ID allocation.
setWorkbotHost({
  async requestJson() {
    return { response: new Response(), payload: { demonstration: {
      id: "cf8de71f-19e4-434c-ab81-921e4181a667", phase: "paused", tabId: "tab",
      steps: [{ id: 1, kind: "note", explanation: "Review the public results." }],
    } } };
  },
  async prepare(path) { return { url: path, headers: new Headers(), credentials: "same-origin" }; },
  user: null, useConnectedApps: () => [], appIcons: () => [], homeHref: "/", browserDemonstrations: true,
});

function Fixture() {
  const [open, setOpen] = useState(true);
  return <main className="workbot" style={{ minHeight: "100vh", padding: 24, background: "var(--wb-bg)" }}>
    <TeachButton open={open} recording={false} onClick={() => setOpen(current => !current)} />
    <div style={{ display: "flex", gap: 24, alignItems: "flex-start", marginTop: 16 }}>
      <WorkbotTeaching open={open} onOpenChange={setOpen} onTakeControl={() => {}} />
      <WorkbotTeaching open onOpenChange={() => {}} onTakeControl={() => {}} />
    </div>
  </main>;
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);

import { addInitScript, browserScript, evaluate } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { sidebarProofWorkspace } from "./sidebar-proof-workspace.ts";

declare global {
  interface Window {
    __proofComputerRequest?: { publish(): boolean; dismissed: boolean };
  }
}

/** A synthetic Electron preload at the IPC boundary, not a renderer store or status override. */
export async function sidebarComputerApproval(seed: Seed) {
  const { app } = await sidebarProofWorkspace(seed, "sidebar-computer-approval");
  const approval = await seed.session(app, { title: "Review the project notes" });
  const unrelated = await seed.session(app, { title: "Plan the team offsite" });
  await addInitScript(app.client, browserScript((sessionId, baseUrl) => {
    const request = {
      id: "proof-private-value-approval", reason: "credential", computer: "Demo computer", placement: "local",
      credential: { site: "https://demo.invalid", fills: [{ field: "password", ask: "Demo access phrase" }], keep: false },
    } as const;
    type Event = { sessionId: string; request: typeof request | null };
    let subscriber: ((event: Event) => void) | undefined;
    const fixture = {
      publish() {
        if (!subscriber) return false;
        subscriber({ sessionId, request });
        return true;
      },
      dismissed: false,
    };
    window.__proofComputerRequest = fixture;
    Object.defineProperty(window, "__OPENWORK_ELECTRON__", { value: {
      computer: {
        onRequest(callback: (event: Event) => void) {
          subscriber = callback;
          return () => { if (subscriber === callback) subscriber = undefined; };
        },
      },
      async invokeDesktop(command: string, input?: { sessionId: string; id: string; answer: string }) {
        if (command === "openworkServerInfo") {
          return { running: true, baseUrl, ownerToken: localStorage.getItem("openwork.server.token"), port: Number(new URL(baseUrl).port) };
        }
        if (command === "computerAnswerRequest") {
          if (input?.sessionId !== sessionId || input?.id !== request.id || input?.answer !== "dismiss") throw new Error("Unexpected synthetic approval answer");
          fixture.dismissed = true;
          subscriber?.({ sessionId, request: null });
        }
        // No native actions, script execution, real profile, or account exist in this world.
        return null;
      },
    } });
  }, [approval.sessionId, app.openworkUrl]));
  return {
    app, approval, unrelated,
    publish: () => evaluate(app.client, () => window.__proofComputerRequest?.publish() ?? false),
    dismissed: () => evaluate(app.client, () => window.__proofComputerRequest?.dismissed ?? false),
  };
}

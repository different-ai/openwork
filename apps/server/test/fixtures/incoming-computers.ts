import { expect } from "vitest";
import { computerActionForToolCall } from "@openwork/computers";
import type { ComputerSharingSettings } from "@openwork/types/computer-sharing";
import { computerCommandCompleteRequestSchema, type ComputerCommandAssignment, type ComputerCommandCompleteRequest, type ComputerToolCall } from "@openwork/types/den/computers";
import { createIncomingRunner } from "../../src/computers/incoming-runner.js";
import type { createIncomingSandbox } from "../../src/computers/incoming-sandbox.js";

export const incomingCredential = { baseUrl: "https://den.example.test", token: "fixture-runner" };
export function incomingAssignment(call: ComputerToolCall, settings: ComputerSharingSettings, id = "command-1"): ComputerCommandAssignment {
  return {
    id, call, action: computerActionForToolCall(call), expiresAt: new Date(Date.now() + 120_000).toISOString(),
    source: { id: "source-computer", label: "Studio Mac", kind: "member_machine", provider: "openwork_desktop", ownerMemberId: "member-fixture", availability: "online" },
    scope: { surface: "sandbox", folders: settings.folders.map(folder => folder.path), writableFolders: settings.folders.filter(folder => folder.access === "edit").map(folder => folder.path) },
  };
}
export function fakeIncomingDen(items: ComputerCommandAssignment[], settings: () => ComputerSharingSettings, sandbox: Pick<ReturnType<typeof createIncomingSandbox>, "run" | "stop">) {
  const results = new Map<string, ComputerCommandCompleteRequest>();
  const requests: string[] = [];
  let waiting: AbortSignal | undefined;
  const runner = createIncomingRunner({ sandbox, settings: async () => settings(), available: async () => true, rejected: () => {}, featureOff: () => {},
    async fetch(input, init) {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${incomingCredential.token}`);
      const { pathname, search } = new URL(input);
      requests.push(pathname);
      if (pathname === "/v1/computer-runners/commands") {
        expect(search).toBe("?waitMs=25000");
        const next = items.filter(item => !results.has(item.id));
        if (!next.length && init?.signal) {
          waiting = init.signal;
          const signal = init.signal;
          await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        return Response.json({ items: next.map(({ id, expiresAt }) => ({ id, expiresAt })) });
      }
      const command = items.find(item => pathname.startsWith(`/v1/computer-commands/${item.id}/`));
      if (!command) return Response.json({ error: "command_not_found" }, { status: 404 });
      expect(init?.method).toBe("POST");
      if (pathname.endsWith("/claim")) return Response.json({ assignment: command });
      if (pathname.endsWith("/complete") && typeof init?.body === "string") {
        results.set(command.id, computerCommandCompleteRequestSchema.parse(JSON.parse(init.body)));
        return Response.json({ command: { id: command.id, status: results.get(command.id)?.status } });
      }
      throw new Error("Unexpected path");
    },
  });
  return { runner, results, requests, waiting: () => waiting };
}

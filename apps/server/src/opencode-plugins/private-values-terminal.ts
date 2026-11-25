import { fillOnlyProgramIn } from "../agent-permission-engine.js";
import { uiBridgeRequest } from "./openwork-ui-bridge.js";

export type TerminalBlock = { blocked: boolean; source: string; programs: string[] };
export type TerminalBlockRequest = () => Promise<TerminalBlock | null>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function terminalBlockReply(value: unknown): TerminalBlock | null {
  if (!record(value) || value.ok !== true || typeof value.blocked !== "boolean") return null;
  const programs = Array.isArray(value.programs) ? value.programs.filter((name): name is string => typeof name === "string" && name.length > 0) : [];
  return { blocked: value.blocked, source: typeof value.source === "string" && value.source ? value.source : "Everyone", programs };
}

const askDesktop: TerminalBlockRequest = async () =>
  terminalBlockReply(await uiBridgeRequest("/private/terminal", { method: "POST", body: { check: true }, timeoutMs: 10_000 }));

export function fillOnlyRefusal(program: string, source: string): string {
  return `"${program}" was used to get a private value, so your organization keeps it out of your own terminal (set for ${source}), where you would read what it prints. Nothing was run. To type a value it prints into a website, use fill_from with that command; to give it to a program or an https request, use use_private_values. OpenWork runs the command after the person approves, and you never see the value. Tell the person if you cannot do the task that way.`;
}

export async function refuseFillOnlyPrograms(tool: string, args: unknown, ask: TerminalBlockRequest = askDesktop): Promise<void> {
  if (tool !== "bash" && tool !== "shell") return;
  const command = record(args) ? args.command : undefined;
  if (typeof command !== "string") return;
  const block = await ask().catch(() => null);
  if (!block?.blocked) return;
  const program = fillOnlyProgramIn(command, block.programs);
  if (program !== null) throw new Error(fillOnlyRefusal(program, block.source));
}

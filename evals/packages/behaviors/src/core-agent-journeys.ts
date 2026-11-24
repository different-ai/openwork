// Steps shared by the agent core journeys (evals/core): permissions,
// connectors in chat, live connector and skill changes, models and the
// built-in browser. Everything here goes through what a person sees or the
// OpenWork server's public HTTP API that the app itself calls.
import { createHash } from "node:crypto";
import type { MockAgentToolStep } from "@openwork/labs";
import type { Probe, User } from "@openwork/testkit";

type Engine = "v1" | "v2";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One agent turn the scripted model answers by calling `steps`. With `approve`
 * the member clicks Allow once on the prompt; with `deny` they click Deny and
 * the turn may end without a reply. Returns the prompt it sent.
 */
export async function runToolTurn(
  actors: { user: User },
  world: { prepareTurn(prompt: string, reply: string, steps: MockAgentToolStep[]): Promise<void> },
  label: string,
  steps: MockAgentToolStep[],
  options: { approve?: boolean; deny?: boolean } = {},
): Promise<string> {
  const { user } = actors;
  const nonce = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const prompt = `${label} ${nonce()}`;
  const reply = `${label} done. ${nonce()}`;
  await world.prepareTurn(prompt, reply, steps);
  await user.type("composer", prompt);
  await user.click("Run task");
  const answer = options.approve ? "Allow once" : options.deny ? "Deny" : null;
  if (answer) {
    await user.see(answer, { timeoutMs: 120_000 });
    await user.screenshot();
    await user.click(answer);
  }
  if (!options.deny) await user.see({ text: reply }, { timeoutMs: 120_000 });
  return prompt;
}

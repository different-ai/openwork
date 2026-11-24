import type { BrowserSecretKind, BrowserSecretSummary, ComputerRequest } from "@openwork/types/desktop-ipc";
export type CloudComputerStatus = { ready: boolean; paused: boolean; busy: boolean; sessionId: string | null };
export type CloudComputerFrame = { dataUrl: string; width: number; height: number; screenWidth: number; screenHeight: number; generation: number };
/** Read-only kernel policy diagnostics from the authenticated desktop helper. */
export function browserEgressStatus(execute?: (command: string, args: string[]) => Promise<string>): Promise<{ ok: boolean; backend: "unknown" | "nft" | "iptables"; stage?: string; uid?: number; chains?: unknown[]; rejects?: unknown[] }>;
/** The person's answer to adding a secret. `error` is a sentence for the person and never repeats what they typed. */
export type CloudComputerSecretAdded = { ok: true; secret: BrowserSecretSummary } | { ok: false; code: "feature_disabled" | "invalid_secret"; error: string };
/**
 * Secret handles of the cloud browser, kept in the computer's memory only and per conversation. Every method but
 * `add` rejects with code `feature_disabled` unless the cloud computer and the secret handles rollout are both verified.
 */
export interface CloudComputerSecrets {
  list(sessionId: string): Promise<BrowserSecretSummary[]>;
  add(input: { sessionId: string; label: string; kind: BrowserSecretKind; origins: string[]; value: string }): Promise<CloudComputerSecretAdded>;
  remove(sessionId: string, secretRef: string): Promise<boolean>;
}
export interface CloudComputer {
  task(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  secrets: CloudComputerSecrets;
  /** The conversation's open approval to enter a secret, in the shape the chat's approval card renders. */
  request(sessionId: string): Promise<ComputerRequest | null>;
  /** Only `allow` with the open request's id approves. False when nothing was open under that id for that conversation. */
  answerRequest(input: { sessionId: string; id: string; answer: "allow" | "dismiss" }): Promise<boolean>;
  snapshot(): Promise<CloudComputerStatus>;
  frame(): Promise<CloudComputerFrame>;
  interact(input: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export function createCloudComputer(options: { directory: string; display?: string; enabled: () => Promise<boolean>; onActivity?: () => void; /** Operator diagnostics only: lets the browser open loopback and private pages. */ privateBrowsing?: boolean; /** The verified secret handles rollout, read on the same cadence as `enabled`. Off unless given. */ secretsEnabled?: () => Promise<boolean>; /** How long one operation may run, not counting the time it waits for the person's answer. 120 seconds unless given. */ operationMs?: number; /** How long an approval to enter a secret waits for the person before it counts as declined. Five minutes unless given. */ requestMs?: number; applications?: { list(): Promise<unknown>; launch(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>; script(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> } }): Promise<CloudComputer>;

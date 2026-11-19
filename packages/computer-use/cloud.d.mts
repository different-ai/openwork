export type CloudComputerStatus = { ready: boolean; paused: boolean; busy: boolean; sessionId: string | null };
export type CloudComputerFrame = { dataUrl: string; width: number; height: number; screenWidth: number; screenHeight: number; generation: number };
/** Read-only kernel policy diagnostics from the authenticated desktop helper. */
export function browserEgressStatus(execute?: (command: string, args: string[]) => Promise<string>): Promise<{ ok: boolean; backend: "unknown" | "nft" | "iptables"; stage?: string; uid?: number; chains?: unknown[]; rejects?: unknown[] }>;
export interface CloudComputer {
  task(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  snapshot(): Promise<CloudComputerStatus>;
  frame(): Promise<CloudComputerFrame>;
  interact(input: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export function createCloudComputer(options: { directory: string; display?: string; enabled: () => Promise<boolean>; onActivity?: () => void; /** Operator diagnostics only: lets the browser open loopback and private pages. */ privateBrowsing?: boolean; applications?: { list(): Promise<unknown>; launch(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>; script(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> } }): Promise<CloudComputer>;

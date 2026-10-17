export type CloudComputerStatus = { ready: boolean; paused: boolean; busy: boolean; sessionId: string | null };
export type CloudComputerFrame = { dataUrl: string; width: number; height: number; screenWidth: number; screenHeight: number; generation: number };
export interface CloudComputer {
  task(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  snapshot(): Promise<CloudComputerStatus>;
  frame(): Promise<CloudComputerFrame>;
  interact(input: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export function createCloudComputer(options: { directory: string; display?: string; enabled: () => Promise<boolean>; onActivity?: () => void; applications?: { list(): Promise<unknown>; launch(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> } }): Promise<CloudComputer>;

import type { ChildProcess, SpawnOptions, ExecFileOptions, ExecFileException } from "node:child_process";
export { spawn, execFile } from "node:child_process";
export function runFile(file: string, args: readonly string[], options?: ExecFileOptions): Promise<{ stdout: string; stderr: string }>;
export function runFileResult(file: string, args: readonly string[], options?: ExecFileOptions): Promise<{ status: number | null; stdout: string; stderr: string; error: ExecFileException | null }>;
export function spawned(child: ChildProcess): Promise<void>;
export interface ProcessLauncher {
  spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
  execFile(file: string, args: readonly string[], options: ExecFileOptions, callback: (error: ExecFileException | null, stdout: string, stderr: string) => void): ChildProcess;
}
export function installProcessLauncher(launcher: ProcessLauncher): () => void;

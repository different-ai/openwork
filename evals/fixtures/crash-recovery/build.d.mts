export interface RecoveryBuild {
  output: string; version: string; release: string;
  manifest: { sourceHash: string; version: string; release: string; ref: string | null; files: { path: string; sha256: string }[] };
  assets: Map<string, { body: string; contentType: string }>;
}
export function recoveryBuild(): Promise<RecoveryBuild>;

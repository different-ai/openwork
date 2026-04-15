export type SandboxBackendType = "docker" | "microsandbox";

export type SandboxCreateModeConfig = {
  backend: SandboxBackendType;
  sandboxImageRef: string | null;
  runtimeReadyLabel: string;
  runtimeCheckingStage: string;
};

export const MICRO_SANDBOX_IMAGE_REF = "openwork-microsandbox:dev";

export function resolveSandboxCreateMode(useMicrosandbox: boolean): SandboxCreateModeConfig {
  if (useMicrosandbox) {
    return {
      backend: "microsandbox",
      sandboxImageRef: MICRO_SANDBOX_IMAGE_REF,
      runtimeReadyLabel: "Microsandbox runtime ready",
      runtimeCheckingStage: "Checking sandbox runtime...",
    };
  }

  return {
    backend: "docker",
    sandboxImageRef: null,
    runtimeReadyLabel: "Docker ready",
    runtimeCheckingStage: "Checking Docker...",
  };
}

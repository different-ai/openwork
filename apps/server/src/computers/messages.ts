export const computerCannotTakeWork = (label: string) => `${label} can't take work from other computers yet.`;
export const computerUnreachable = (label: string) => `OpenWork couldn't reach ${label}. Nothing ran there.`;
export const computerNeedsDaytonaKey = (label: string) => `${label} needs its Daytona key on this machine before OpenWork can reach it. Nothing ran there.`;
export const computerMissing = (label: string) => `${label} no longer exists at its provider. Choose another computer. Nothing ran there.`;
export const computerProviderProblem = (label: string) => `${label} has a problem at its provider. Check it with the provider before trying again. Nothing ran there.`;
export const computerBindingChanged = "This chat's computer changed while waiting for approval. Nothing ran.";
export const computerApprovalUnavailable = "Nothing ran on the other computer. Update OpenWork to use chat approvals there.";

export function computerOutcomeUnknown(label: string, stopped: boolean) {
  const outcome = stopped
    ? `OpenWork stopped waiting for ${label}, but the operation may have partly run or already finished.`
    : `OpenWork doesn't know how the operation ended on ${label}. It may have finished.`;
  return `${outcome} Check the file or folder on that computer before running it again.`;
}

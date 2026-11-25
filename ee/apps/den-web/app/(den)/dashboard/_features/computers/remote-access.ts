import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import type { RemoteDeviceAccess } from "@openwork/types/den/remote-devices";

export const REMOTE_ACCESS_LABEL = "Other devices can";

const VALUES: Record<RemoteSessionAccessMode, string> = {
  off: "Nothing",
  created: "Start tasks",
  all: "Start tasks and open sessions",
};

export function remoteAccessValue(access: Pick<RemoteDeviceAccess, "effective">): string {
  return VALUES[access.effective];
}

export type RemoteAccessVoice = "owner" | "team";

export function remoteAccessNote(access: Pick<RemoteDeviceAccess, "effective" | "reason">, voice: RemoteAccessVoice = "owner"): string | null {
  const team = voice === "team";
  if (access.reason === "organization") {
    if (access.effective === "off") return team ? "Turned off for the organization." : "Your organization has turned this off.";
    return team ? "The organization doesn't allow more." : "Your organization doesn't allow more.";
  }
  if (access.reason === "not_chosen") return team ? "Not allowed by its owner yet." : "Not allowed yet. Allow it in Settings › Devices on that computer.";
  if (access.reason === "update_required") return team ? "Needs an OpenWork update before its owner can allow it." : "Update OpenWork on this computer to allow it.";
  if (access.effective === "off") return team ? "Turned off by its owner." : "Turned off on that computer.";
  return null;
}

export const REMOTE_ACCESS_CHANGE_HINT = "Change it in Settings › Devices on that computer.";

export function remoteAccessChangeHint(access: Pick<RemoteDeviceAccess, "effective" | "reason">): string | null {
  if (access.reason === null) return REMOTE_ACCESS_CHANGE_HINT;
  if (access.reason === "organization" && access.effective !== "off") return REMOTE_ACCESS_CHANGE_HINT;
  return null;
}

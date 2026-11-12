import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import type { RemoteDeviceAccess } from "@openwork/types/den/remote-devices";

/*
 * What a computer's owner's other devices, Workbot and agents working for
 * them may do on it, in words. One place, used by My Computers (said to the
 * owner) and by the team list (said about someone else's computer).
 *
 * The facts come with the computer (`remoteAccess` on a device record). It
 * is null for a computer that takes no tasks this way (a virtual computer,
 * Workbot's, a disconnected desktop) and from an API that does not send it
 * yet: nothing is shown for those.
 */

/** The lane and row label: "Other devices can … Start tasks". */
export const REMOTE_ACCESS_LABEL = "Other devices can";

const VALUES: Record<RemoteSessionAccessMode, string> = {
  off: "Nothing",
  created: "Start tasks",
  all: "Start tasks and open sessions",
};

/** What applies on the computer right now. */
export function remoteAccessValue(access: Pick<RemoteDeviceAccess, "effective">): string {
  return VALUES[access.effective];
}

/** `owner`: said to the person whose computer it is. `team`: said to an admin about a member's computer. */
export type RemoteAccessVoice = "owner" | "team";

/**
 * Why less applies than the computer's owner could expect, when there is
 * something to say. Null when their own choice applies and it is not off.
 */
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

/**
 * Where the owner changes it, for their open row. Said only when changing it
 * there does something and the note has not already said how: not while the
 * organization has it off, the computer waits to be allowed, or the app has
 * to be updated first.
 */
export function remoteAccessChangeHint(access: Pick<RemoteDeviceAccess, "effective" | "reason">): string | null {
  if (access.reason === null) return REMOTE_ACCESS_CHANGE_HINT;
  if (access.reason === "organization" && access.effective !== "off") return REMOTE_ACCESS_CHANGE_HINT;
  return null;
}

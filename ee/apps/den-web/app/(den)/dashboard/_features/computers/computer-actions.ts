import type { RemoteDevice } from "@openwork/types/den/remote-devices";
import { FORMER_MEMBER_LABEL, isFormerOwner, type OrganizationComputer } from "./computers-format";

export type ComputerAction = "rename" | "disconnect" | "remove";

export type ConfirmCopy = { title: string; description: string; action: string };

export function myComputerActions(device: Pick<RemoteDevice, "canRename" | "canDisconnect" | "canRemove">): ComputerAction[] {
  return [
    ...(device.canRename ? ["rename" as const] : []),
    ...(device.canDisconnect ? ["disconnect" as const] : []),
    ...(device.canRemove ? ["remove" as const] : []),
  ];
}

export function teamComputerActions(device: Pick<OrganizationComputer, "canDisconnect" | "canRemove">): ComputerAction[] {
  return [
    ...(device.canDisconnect ? ["disconnect" as const] : []),
    ...(device.canRemove ? ["remove" as const] : []),
  ];
}

export function disconnectLocked(
  device: Pick<OrganizationComputer, "kind" | "disconnectedAt" | "removedAt" | "canDisconnect" | "canRemove">,
  canDisconnectComputers: boolean,
): boolean {
  return !canDisconnectComputers && !device.canDisconnect && !device.canRemove
    && device.kind === "desktop" && !device.disconnectedAt && !device.removedAt;
}

export const DISCONNECT_OWNER_BODY = "OpenWork on that computer is signed out and it stops taking tasks and sharing sessions. Sign in on it again to reconnect it.";

export function disconnectOwnConfirm(name: string): ConfirmCopy {
  return { title: `Disconnect ${name}?`, description: DISCONNECT_OWNER_BODY, action: "Disconnect" };
}

export function disconnectOwnerName(device: Pick<OrganizationComputer, "owner" | "shared">): string {
  if (isFormerOwner(device)) return `A ${FORMER_MEMBER_LABEL.toLowerCase()}`;
  return device.owner?.name?.trim() || device.owner?.email?.trim() || `A ${FORMER_MEMBER_LABEL.toLowerCase()}`;
}

export function disconnectTeamConfirm(name: string, owner: string, organization: string): ConfirmCopy {
  return {
    title: `Disconnect ${name}?`,
    description: `${owner}'s OpenWork on that computer is signed out of ${organization} and it stops taking tasks and sharing sessions. They can sign in on it again to reconnect it.`,
    action: "Disconnect",
  };
}

export function removeConfirm(name: string): ConfirmCopy {
  return { title: `Remove ${name} from the list?`, description: "This only removes the entry. It doesn't stop or delete the computer.", action: "Remove" };
}

export function disconnectedMessage(signedOut: boolean): { title: string; description: string } {
  return signedOut
    ? { title: "Disconnected", description: "OpenWork was signed out on that computer." }
    : { title: "Disconnected", description: "It can't act as a computer until someone signs in on it again." };
}

export function disconnectedLine(signedOut: boolean): string {
  const message = disconnectedMessage(signedOut);
  return `${message.title}. ${message.description}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ACTION_VERBS: Record<ComputerAction, string> = { rename: "rename", disconnect: "disconnect", remove: "remove" };

export function computerActionError(action: ComputerAction, status: number, payload: unknown): string {
  const message = isRecord(payload) && typeof payload.message === "string" ? payload.message.trim() : "";
  if (message) return message;
  const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "";
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 404) return "This computer is no longer in the list. Refresh to see what changed.";
  if (code === "disconnect_first") return "Disconnect this computer first, then remove it.";
  if (code === "not_disconnectable") return "This computer can't be disconnected. Only a signed-in desktop can.";
  if (status === 403) return `You don't have permission to ${ACTION_VERBS[action]} this computer.`;
  return `Couldn't ${ACTION_VERBS[action]} this computer. Try again.`;
}

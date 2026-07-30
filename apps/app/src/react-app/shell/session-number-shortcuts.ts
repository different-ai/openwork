export const SESSION_NUMBER_SHORTCUT_LIMIT = 9;

export type SessionNumberShortcutOs = "macos" | "windows" | "linux";

export type SessionNumberShortcutTarget = {
  workspaceId: string;
  sessionId: string;
  digit: number;
};

export type SessionNumberShortcutsState = {
  modifierHeld: boolean;
  os: SessionNumberShortcutOs;
  targets: readonly SessionNumberShortcutTarget[];
};

export type SessionNumberShortcutCandidate = {
  workspaceId: string;
  sessionId: string;
  visible: boolean;
  actionable: boolean;
};

type SessionNumberShortcutEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

type SessionNumberShortcutIntent =
  | { type: "ignore" }
  | { type: "hold" }
  | { type: "activate"; digit: number };

type SessionNumberShortcutIntentOptions = {
  ownerActive: boolean;
  cancelled: boolean;
};

export type SessionNumberShortcutTransition =
  | "modifier-down"
  | "modifier-up"
  | "modifier-mismatch"
  | "blur"
  | "focus"
  | "visibility-hidden"
  | "owner-change"
  | "unmount";

const SESSION_ROW_SELECTOR =
  "[data-sidebar-session-id][data-sidebar-session-workspace-id]";
const SHORTCUT_OWNER_CANDIDATE_SELECTOR = [
  '[data-slot="dialog-content"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
].join(",");

export function sessionNumberShortcutTargetKey(workspaceId: string, sessionId: string) {
  return `${workspaceId}\u0000${sessionId}`;
}

export function resolveSessionNumberShortcutOs(
  platformOs: SessionNumberShortcutOs | undefined,
  navigatorPlatform: string,
): SessionNumberShortcutOs {
  if (platformOs) return platformOs;
  if (/mac/i.test(navigatorPlatform)) return "macos";
  if (/win/i.test(navigatorPlatform)) return "windows";
  return "linux";
}

export function assignSessionNumberShortcuts(
  candidates: readonly SessionNumberShortcutCandidate[],
): SessionNumberShortcutTarget[] {
  return candidates
    .filter((candidate) => candidate.visible && candidate.actionable)
    .slice(0, SESSION_NUMBER_SHORTCUT_LIMIT)
    .map((candidate, index) => ({
      workspaceId: candidate.workspaceId,
      sessionId: candidate.sessionId,
      digit: index + 1,
    }));
}

export function sessionNumberAriaKeyShortcut(os: SessionNumberShortcutOs, digit: number) {
  return `${os === "macos" ? "Meta" : "Control"}+${digit}`;
}

export function sessionNumberShortcutLabel(os: SessionNumberShortcutOs, digit: number) {
  return os === "macos" ? `⌘${digit}` : `Ctrl+${digit}`;
}

export function sessionNumberShortcutDescription(os: SessionNumberShortcutOs, digit: number) {
  return `Open this session with ${sessionNumberShortcutLabel(os, digit)}`;
}

export function sessionNumberShortcutHelp(os: SessionNumberShortcutOs) {
  const modifier = os === "macos" ? "Command" : "Ctrl";
  return {
    title: "Open a visible session by number",
    detail: `Hold ${modifier} to reveal shortcuts beside the first nine visible sessions, then press 1–9.`,
    meta: os === "macos" ? "⌘1–⌘9" : "Ctrl+1–9",
    searchText: "keyboard shortcut visible session number jump open command control 1 2 3 4 5 6 7 8 9",
  };
}

function isVisibleElement(element: Element) {
  return element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true";
}

export function isSessionNumberShortcutBlockingOwner(
  element: Pick<Element, "getAttribute">,
) {
  const slot = element.getAttribute("data-slot");
  const role = element.getAttribute("role");
  if (slot === "popover-content") return false;
  return (
    slot === "dialog-content" ||
    role === "dialog" ||
    role === "alertdialog"
  );
}

export function hasSessionNumberShortcutOwner(documentRoot: Document) {
  return Array.from(documentRoot.querySelectorAll(SHORTCUT_OWNER_CANDIDATE_SELECTOR)).some(
    (element) => isSessionNumberShortcutBlockingOwner(element) && isVisibleElement(element),
  );
}

export function getSessionNumberShortcutIntent(
  event: SessionNumberShortcutEvent,
  os: SessionNumberShortcutOs,
  options: SessionNumberShortcutIntentOptions,
): SessionNumberShortcutIntent {
  const modifierKey = os === "macos" ? "Meta" : "Control";
  const modifierPressed = isSessionNumberModifierPressed(event, os);
  const oppositeModifierPressed = os === "macos" ? event.ctrlKey : event.metaKey;
  if (event.key === modifierKey) {
    return options.ownerActive ? { type: "ignore" } : { type: "hold" };
  }
  if (
    !modifierPressed ||
    oppositeModifierPressed ||
    event.shiftKey ||
    event.altKey ||
    options.ownerActive ||
    options.cancelled
  ) {
    return { type: "ignore" };
  }
  if (!/^[1-9]$/.test(event.key)) return { type: "hold" };
  return { type: "activate", digit: Number(event.key) };
}

export function isSessionNumberModifierKey(key: string, os: SessionNumberShortcutOs) {
  return key === (os === "macos" ? "Meta" : "Control");
}

export function isSessionNumberModifierPressed(
  event: Pick<SessionNumberShortcutEvent, "metaKey" | "ctrlKey">,
  os: SessionNumberShortcutOs,
) {
  return os === "macos" ? event.metaKey : event.ctrlKey;
}

export function nextSessionNumberModifierHeld(
  transition: SessionNumberShortcutTransition,
) {
  return transition === "modifier-down";
}

type SessionNumberShortcutDomTarget = SessionNumberShortcutTarget & {
  button: HTMLElement;
};

export function readVisibleSessionNumberShortcutTargets(
  documentRoot: Document,
): SessionNumberShortcutDomTarget[] {
  const rows = Array.from(documentRoot.querySelectorAll<HTMLElement>(SESSION_ROW_SELECTOR));
  const candidates = rows.flatMap((row) => {
    const button = row.querySelector<HTMLElement>("[data-session-tab-id]");
    const workspaceId = row.dataset.sidebarSessionWorkspaceId?.trim();
    const sessionId = row.dataset.sidebarSessionId?.trim();
    if (!button || !workspaceId || !sessionId) return [];
    return [{
      workspaceId,
      sessionId,
      visible: isVisibleElement(button),
      actionable: !button.matches('[disabled], [aria-disabled="true"]'),
      button,
    }];
  });
  const assigned = assignSessionNumberShortcuts(candidates);
  return assigned.flatMap((target) => {
    const match = candidates.find((candidate) => (
      candidate.workspaceId === target.workspaceId && candidate.sessionId === target.sessionId
    ));
    return match ? [{ ...target, button: match.button }] : [];
  });
}

export function sameSessionNumberShortcutTargets(
  left: readonly SessionNumberShortcutTarget[],
  right: readonly SessionNumberShortcutTarget[],
) {
  return left.length === right.length && left.every((target, index) => {
    const other = right[index];
    return other?.workspaceId === target.workspaceId &&
      other.sessionId === target.sessionId &&
      other.digit === target.digit;
  });
}

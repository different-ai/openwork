// Desktop sign-in intent and pending organization selection.
//
// The desktop handoff exchange always reports an organization: den-api
// hydrates the browser session's active organization server-side whenever it
// is empty, so the payload cannot distinguish "the user chose this org
// remotely" from "the server defaulted one". The reliable discriminator is
// who initiated the sign-in:
//
// - Remotely-initiated handoffs (install/invite links, enterprise bootstrap,
//   "Open in desktop" from the Cloud dashboard) carry the org the user is
//   actually working in — connect straight through.
// - Desktop-initiated sign-ins restore a remembered choice only after the
//   destination verifies the returning account's membership and rollout.
//   Without that, they must not silently adopt a server-resolved org when the
//   account has several; the exchange org is only a chooser suggestion.
//
// This module owns the short-lived "the desktop started this sign-in" marker
// and the "organization selection pending" state the routing and auth layers
// consult between token exchange and the user's explicit choice.

const DESKTOP_SIGN_IN_STARTED_AT_KEY = "openwork.den.desktopSignInStartedAt";
const ORG_SELECTION_PENDING_KEY = "openwork.den.orgSelectionPendingAt";
const ORG_SELECTION_SUGGESTION_KEY = "openwork.den.orgSelectionSuggestion";

/** Comfortably outlives the 5-minute handoff grant plus the browser round
 * trip, without leaving a stale marker that reclassifies a much later,
 * unrelated remote handoff. */
export const DESKTOP_SIGN_IN_INTENT_TTL_MS = 15 * 60 * 1000;

export type SignInOrgRef = {
  id: string;
  slug?: string | null;
  name?: string | null;
};

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Record that the desktop app itself started a sign-in flow. */
export function markDesktopSignInInitiated(now: number = Date.now()) {
  storage()?.setItem(DESKTOP_SIGN_IN_STARTED_AT_KEY, String(now));
}

export function clearDesktopSignInIntent() {
  storage()?.removeItem(DESKTOP_SIGN_IN_STARTED_AT_KEY);
}

export function hasActiveDesktopSignInIntent(now: number = Date.now()): boolean {
  return isDesktopSignInIntentActive(storage()?.getItem(DESKTOP_SIGN_IN_STARTED_AT_KEY) ?? null, now);
}

/** Pure form of the marker check for tests and reuse. */
export function isDesktopSignInIntentActive(startedAtRaw: string | null, now: number): boolean {
  if (!startedAtRaw) return false;
  const startedAt = Number.parseInt(startedAtRaw, 10);
  if (!Number.isFinite(startedAt)) return false;
  if (now < startedAt) return true;
  return now - startedAt <= DESKTOP_SIGN_IN_INTENT_TTL_MS;
}

export function markOrgSelectionPending(suggestion: SignInOrgRef | null, now: number = Date.now()) {
  const store = storage();
  if (!store) return;
  store.setItem(ORG_SELECTION_PENDING_KEY, String(now));
  if (suggestion?.id?.trim()) {
    store.setItem(
      ORG_SELECTION_SUGGESTION_KEY,
      JSON.stringify({
        id: suggestion.id,
        slug: suggestion.slug ?? null,
        name: suggestion.name ?? null,
      }),
    );
  } else {
    store.removeItem(ORG_SELECTION_SUGGESTION_KEY);
  }
}

export function clearOrgSelectionPending() {
  const store = storage();
  if (!store) return;
  store.removeItem(ORG_SELECTION_PENDING_KEY);
  store.removeItem(ORG_SELECTION_SUGGESTION_KEY);
}

export type OrgSelectionPendingState = {
  pending: boolean;
  suggestion: SignInOrgRef | null;
};

export function readOrgSelectionPending(): OrgSelectionPendingState {
  const store = storage();
  if (!store?.getItem(ORG_SELECTION_PENDING_KEY)) {
    return { pending: false, suggestion: null };
  }
  let suggestion: SignInOrgRef | null = null;
  const raw = store.getItem(ORG_SELECTION_SUGGESTION_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<SignInOrgRef> | null;
      if (parsed && typeof parsed.id === "string" && parsed.id.trim()) {
        suggestion = {
          id: parsed.id,
          slug: typeof parsed.slug === "string" ? parsed.slug : null,
          name: typeof parsed.name === "string" ? parsed.name : null,
        };
      }
    } catch {
      suggestion = null;
    }
  }
  return { pending: true, suggestion };
}

export type HandoffOrgPlan =
  | { kind: "commit"; organization: SignInOrgRef | null }
  | { kind: "await-user-selection"; suggestion: SignInOrgRef | null };

/**
 * Decide what a successful handoff exchange does with the organization.
 *
 * - An explicitly scoped org (install/invite link, enterprise bootstrap) is
 *   always committed — the link itself is the remote selection.
 * - A desktop-initiated sign-in restores a verified remembered choice, if
 *   supplied. Otherwise the exchange org is only a chooser suggestion and
 *   onboarding decides (silently auto-selecting single-org accounts).
 * - A remotely-initiated handoff commits the exchange-reported org — it is
 *   the organization the user's Cloud session is actually working in.
 */
export function resolveHandoffOrgPlan(input: {
  explicitActiveOrg: SignInOrgRef | null;
  exchangeOrganization: SignInOrgRef | null;
  desktopInitiated: boolean;
  /** Already membership-validated and allowed by the destination's live rollout. */
  rememberedOrganization?: SignInOrgRef | null;
}): HandoffOrgPlan {
  if (input.explicitActiveOrg?.id?.trim()) {
    return { kind: "commit", organization: input.explicitActiveOrg };
  }
  if (input.desktopInitiated) {
    if (input.rememberedOrganization?.id?.trim()) {
      return { kind: "commit", organization: input.rememberedOrganization };
    }
    return { kind: "await-user-selection", suggestion: input.exchangeOrganization };
  }
  return { kind: "commit", organization: input.exchangeOrganization };
}

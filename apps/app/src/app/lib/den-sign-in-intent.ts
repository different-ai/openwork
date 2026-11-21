const DESKTOP_SIGN_IN_STARTED_AT_KEY = "openwork.den.desktopSignInStartedAt";
const ORG_SELECTION_PENDING_KEY = "openwork.den.orgSelectionPendingAt";
const ORG_SELECTION_SUGGESTION_KEY = "openwork.den.orgSelectionSuggestion";

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

export function markDesktopSignInInitiated(now: number = Date.now()) {
  storage()?.setItem(DESKTOP_SIGN_IN_STARTED_AT_KEY, String(now));
}

export function clearDesktopSignInIntent() {
  storage()?.removeItem(DESKTOP_SIGN_IN_STARTED_AT_KEY);
}

export function hasActiveDesktopSignInIntent(now: number = Date.now()): boolean {
  return isDesktopSignInIntentActive(storage()?.getItem(DESKTOP_SIGN_IN_STARTED_AT_KEY) ?? null, now);
}

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

export function resolveHandoffOrgPlan(input: {
  explicitActiveOrg: SignInOrgRef | null;
  exchangeOrganization: SignInOrgRef | null;
  desktopInitiated: boolean;
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

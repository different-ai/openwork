/** @jsxImportSource react */
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toContain: (expected: string) => void;
  toEqual: (expected: unknown) => void;
};

import { renderToStaticMarkup } from "react-dom/server";

import type { DenOrgSummary } from "../../../app/lib/den";
import {
  clearOrgSelectionPending,
  markOrgSelectionPending,
  readOrgSelectionPending,
} from "../../../app/lib/den-sign-in-intent";
import {
  OrganizationList,
  initialOrgOnboardingSelectionState,
  isAlreadyOnboardedExit,
  resolveOrgOnboardingPostListStep,
  type PreparedBootstrapSummary,
} from "./org-onboarding-page";

const preparedSummary: PreparedBootstrapSummary = { orgName: "Acme", claimLinks: [] };

/** Minimal in-memory Storage, matching the pattern used elsewhere in this
 * repo's tests (e.g. tests/den-bootstrap-origin-coherence.test.ts) for
 * exercising localStorage-backed helpers outside a browser. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

function org(id: string, name: string): DenOrgSummary {
  return {
    id,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    role: "member",
  };
}

describe("org onboarding organization choice", () => {
  test("keeps a recent handoff unselected so two orgs render the chooser", () => {
    const currentOrg = org("org-current", "Acme Robotics");
    const otherOrg = org("org-other", "Beta Labs");
    const initial = initialOrgOnboardingSelectionState();
    const step = resolveOrgOnboardingPostListStep({
      orgs: [currentOrg, otherOrg],
      activeOrgId: currentOrg.id,
      hasSelectedOrganization: initial.hasSelectedOrganization,
      autoContinueResources: initial.autoContinueResources,
      autoSelectFailedOrgId: null,
    });

    expect(step.kind).toBe("choose-org");
    const markup = renderToStaticMarkup(
      <OrganizationList
        orgs={[currentOrg, otherOrg]}
        value={currentOrg}
        onValueChange={() => {}}
      />,
    );
    expect(markup).toContain("Acme Robotics");
    expect(markup).toContain("Beta Labs");
  });

  test("auto-selects and auto-continues resources for one org", () => {
    const soloOrg = org("org-solo", "Solo Workspace");
    const initial = initialOrgOnboardingSelectionState();
    const autoSelectStep = resolveOrgOnboardingPostListStep({
      orgs: [soloOrg],
      activeOrgId: "",
      hasSelectedOrganization: initial.hasSelectedOrganization,
      autoContinueResources: initial.autoContinueResources,
      autoSelectFailedOrgId: null,
    });

    expect(autoSelectStep).toEqual({
      kind: "auto-select-single-org",
      organization: soloOrg,
    });

    const resourceStep = resolveOrgOnboardingPostListStep({
      orgs: [soloOrg],
      activeOrgId: soloOrg.id,
      hasSelectedOrganization: true,
      autoContinueResources: true,
      autoSelectFailedOrgId: null,
    });

    expect(resourceStep).toEqual({ kind: "resources", autoContinue: true });
  });

  test("shows the chooser for two orgs without a handoff", () => {
    const firstOrg = org("org-first", "First Workspace");
    const activeOrg = org("org-active", "Active Workspace");
    const step = resolveOrgOnboardingPostListStep({
      orgs: [firstOrg, activeOrg],
      activeOrgId: activeOrg.id,
      hasSelectedOrganization: false,
      autoContinueResources: false,
      autoSelectFailedOrgId: null,
    });

    expect(step).toEqual({
      kind: "choose-org",
      defaultOrganization: activeOrg,
    });
  });

  test("falls back to the chooser when single-org auto-selection failed", () => {
    const soloOrg = org("org-solo", "Solo Workspace");
    const step = resolveOrgOnboardingPostListStep({
      orgs: [soloOrg],
      activeOrgId: soloOrg.id,
      hasSelectedOrganization: false,
      autoContinueResources: false,
      autoSelectFailedOrgId: soloOrg.id,
    });

    expect(step).toEqual({
      kind: "choose-org",
      defaultOrganization: soloOrg,
    });
  });
});

describe("org onboarding already-onboarded exit", () => {
  test("recognizes a signed-in user with an active org as having nothing to onboard", () => {
    expect(isAlreadyOnboardedExit({ authToken: "tok", orgId: "org_1", prepared: preparedSummary })).toBe(true);
    expect(isAlreadyOnboardedExit({ authToken: null, orgId: "org_1", prepared: preparedSummary })).toBe(false);
    expect(isAlreadyOnboardedExit({ authToken: "tok", orgId: "", prepared: preparedSummary })).toBe(false);
    expect(isAlreadyOnboardedExit({ authToken: "tok", orgId: "org_1", prepared: null })).toBe(false);
  });

  test("clears a stuck orgSelectionPending flag on this exit, matching the page's other exits", () => {
    const originalWindow = globalThis.window;
    const storage = memoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: storage },
    });

    try {
      // Simulates a desktop-initiated sign-in that parked an org suggestion
      // for the chooser, then reproduce this page's already-onboarded exit
      // without ever showing the chooser (e.g. the account only has the one
      // org the exchange already reported).
      markOrgSelectionPending({ id: "org_1", slug: "acme", name: "Acme" });
      expect(readOrgSelectionPending().pending).toBe(true);

      if (isAlreadyOnboardedExit({ authToken: "tok", orgId: "org_1", prepared: preparedSummary })) {
        clearOrgSelectionPending();
      }

      // Regression guard: if this exit forgets to clear the flag, it stays
      // stuck forever (readOrgSelectionPending has no TTL), and
      // DenSigninGate then redirects every non-onboarding navigation back
      // to /onboarding, which immediately bounces back here — a redirect
      // loop that makes Settings/Library/Extensions unreachable.
      expect(readOrgSelectionPending().pending).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });
});

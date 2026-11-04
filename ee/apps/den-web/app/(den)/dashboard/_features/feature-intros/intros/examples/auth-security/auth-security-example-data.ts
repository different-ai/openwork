import type { ExampleService } from "../example-parts";

/** Sample data only: no API calls (DESIGN.md I7). */

export const OKTA: ExampleService = { name: "Okta", url: "https://okta.com" };

export const EXAMPLE_ORG = "Acme";
export const EXAMPLE_DOMAIN = "acme.com";

/** Settings rows as on the SSO tab: label left, state right (S2). */
export const ssoExampleSettings: ReadonlyArray<{ label: string; detail: string; state: string }> = [
  { label: "Okta", detail: "SAML connection", state: "On" },
  { label: EXAMPLE_DOMAIN, detail: "Email domain", state: "Verified" },
  { label: "Require SSO", detail: `For everyone at ${EXAMPLE_DOMAIN}`, state: "On" },
];

/** Section example: both halves of Auth & Security once running. */
export const authSecurityExampleRows: ReadonlyArray<{ title: string; detail: string; state: string }> = [
  { title: "Single sign-on", detail: `Okta for ${EXAMPLE_DOMAIN}`, state: "On" },
  { title: "User provisioning", detail: "People and groups from Okta", state: "Syncing" },
];

/** What happened, as sentences (C4): sentence first, when on the right. */
export const authSecurityExampleActivity: ReadonlyArray<{ initials: string; sentence: string; when: string }> = [
  { initials: "PS", sentence: "Priya Shah signed in with Okta", when: "2 min ago" },
  { initials: "JM", sentence: "Added Jordan Miles from Okta", when: "1 hr ago" },
  { initials: "SL", sentence: "Removed Sam Lee, deactivated in Okta", when: "Yesterday" },
];

/** SCIM sync log. */
export const scimExampleLog: ReadonlyArray<{ initials: string; title: string; detail: string; meta: string }> = [
  { initials: "PS", title: "Added Priya Shah", detail: "Assigned in Okta", meta: "2 min ago" },
  { initials: "SL", title: "Removed Sam Lee", detail: "Deactivated in Okta", meta: "1 hr ago" },
  { initials: "EN", title: "Synced Engineering group", detail: "Engineering team in OpenWork", meta: "12 people" },
  { initials: "DS", title: "Synced Design group", detail: "Design team in OpenWork", meta: "5 people" },
];

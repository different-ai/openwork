/** @jsxImportSource react */
import { afterEach, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as auth from "../src/react-app/domains/cloud/den-auth-provider";
import * as den from "../src/app/lib/den";
import { useAutomationsDenContext } from "../src/react-app/domains/automations/use-automations";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function ContextState() {
  const context = useAutomationsDenContext();
  return <span data-ready={String(context.ready)} data-principal={context.queryRoot.at(-1) ?? "none"} />;
}
function state(identity: { principalId: string; organizationId: string } | null) {
  const authSpy = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_in", user: { id: "previous_user", name: "Previous Member", email: "previous@example.test" }, verifiedIdentity: identity, error: null, isSignedIn: true, refresh: async () => {} });
  const settingsSpy = spyOn(den, "readDenSettings").mockReturnValue({ baseUrl: "https://den.example.test", authToken: "synthetic-new-credential", activeOrgId: "org_example" });
  cleanups.push(() => authSpy.mockRestore(), () => settingsSpy.mockRestore());
  return renderToStaticMarkup(<ContextState />);
}

test("a retained previous user cannot expose a cache while replacement credentials are unverified", () => {
  const html = state(null);
  expect(html).toContain('data-ready="false"');
  expect(html).toContain('data-principal="none"');
  expect(html).not.toContain("previous_user");
});

test("only the current verified organization identity selects the inventory cache", () => {
  const html = state({ principalId: "current_user", organizationId: "org_example" });
  expect(html).toContain('data-ready="true"');
  expect(html).toContain('data-principal="current_user"');
  expect(html).not.toContain("previous_user");
});

test("a verified identity for another organization cannot enable inventory reads", () => {
  const html = state({ principalId: "current_user", organizationId: "another_org" });
  expect(html).toContain('data-ready="false"');
  expect(html).toContain('data-principal="none"');
});

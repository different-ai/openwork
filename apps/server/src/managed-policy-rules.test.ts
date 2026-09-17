import { expect, test } from "bun:test";
import type { DesktopConfig } from "@openwork/types/den/desktop-policies";
import { policyDenial } from "./managed-policy-rules.js";

test("approved browser origins reject file URLs while allowing an approved HTTPS page", () => {
  const policy: DesktopConfig = {
    execution: { commands: "allow", blockedCommands: [], browserOrigins: ["https://approved.example"], blockBrowserUploads: false },
  };
  expect(policyDenial(policy, "browser", { url: "https://approved.example/page" })).toBeNull();
  expect(policyDenial(policy, "browser", { url: "file:///tmp/browser-policy-witness.html" })).toBe("This website is not approved by your organization.");
});

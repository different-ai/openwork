import { randomUUID } from "node:crypto";
import type { Seed } from "@openwork/env";

export async function initialAdminSetup(seed: Seed) {
  const email = "owner@example.test";
  const setupCode = randomUUID();
  const den = await seed.den({
    provision: false,
    env: {
      DEN_ORG_MODE: "single_org",
      DEN_SINGLE_ORG_NAME: "Example workspace",
      DEN_SINGLE_ORG_SLUG: "example-workspace",
      DEN_SINGLE_ORG_OWNER_EMAILS: email,
      DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "false",
      DEN_INITIAL_ADMIN_BOOTSTRAP_CODE: setupCode,
    },
  });
  const web = await seed.web({ den, startPath: "/setup", headless: true });
  return {
    den, web, email, setupCode,
    async status(): Promise<unknown> {
      const response = await fetch(`${den.ref.apiUrl}/v1/auth/bootstrap/status`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Setup status failed: ${response.status}`);
      return response.json();
    },
    // TODO(primitive): expose native validity, error association, and focus through probe.
    async confirmationState() {
      return seed.evalIn(web, `(() => {
        const input = document.getElementById("setup-confirm-password");
        const error = document.getElementById(input?.getAttribute("aria-describedby"));
        return {
          required: input?.required,
          missing: input?.validity.valueMissing,
          invalid: input?.getAttribute("aria-invalid"),
          focused: document.activeElement === input,
          error: error?.textContent.trim(),
          role: error?.getAttribute("role"),
        };
      })()`);
    },
    async signIn(password: string) {
      const response = await fetch(`${den.ref.apiUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: den.ref.webUrl },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.status;
    },
  };
}

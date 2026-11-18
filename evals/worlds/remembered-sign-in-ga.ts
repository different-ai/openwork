import type { Seed } from "@openwork/env";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Real password authentication in a fresh browser; no feature overrides or cookies are seeded. */
export async function rememberedSignInGa(seed: Seed) {
  const den = await seed.den({
    org: {
      name: "Remembered Sign-in Workspace",
      admin: { name: "Sign-in Operator" },
      members: { returning: { name: "Returning Member" } },
    },
    env: {
      DEN_ORG_MODE: "multi_org",
      DEN_DEPLOYMENT: "cloud",
      DEN_REQUIRE_EMAIL_VERIFICATION: "false",
      DEN_PASSWORD_BREACH_SCREENING_ENABLED: "false",
      OPENWORK_DEV_MODE: "1",
      RESEND_API_KEY: "",
      SMTP_HOST: "",
    },
  });
  const account = den.members.returning;
  if (!account) throw new Error("The returning member account must be provisioned.");
  const viewport = { width: 1440, height: 1000 };
  const web = await seed.web({ den, startPath: "/", headless: true, viewport });
  const freshBrowser = await seed.web({ den, startPath: "/", headless: true, viewport });

  return {
    den,
    web,
    freshBrowser,
    account,
    // Read only the non-secret remembered-method cookie through Chromium's
    // browser protocol. Never expose session cookies or inject browser state.
    async rememberedCookie() {
      const result = await web.client.send("Network.getCookies", { urls: [den.ref.webUrl] });
      if (!isRecord(result) || !Array.isArray(result.cookies)) {
        throw new Error("Chromium did not return its browser cookies.");
      }
      const cookie: unknown = result.cookies.find((entry: unknown) => isRecord(entry) && entry.name === "openwork-last-sign-in");
      if (!isRecord(cookie)) return null;
      return {
        value: cookie.value,
        path: cookie.path,
        sameSite: cookie.sameSite,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expires: cookie.expires,
      };
    },
  };
}

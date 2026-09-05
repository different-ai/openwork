import { signIn } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";

export async function signupWorkspace(seed: Seed) {
  // Capture real rendered emails locally; never use an inherited mail provider.
  const den = await seed.den({ provision: false, env: {
    OPENWORK_DEV_MODE: "1", RESEND_API_KEY: "", SMTP_HOST: "",
    DEN_REQUIRE_EMAIL_VERIFICATION: "false",
    DEN_OPENWORK_WEB_ENABLED: "true",
  } });
  const owner = {
    name: "Workspace Owner",
    email: `workspace-owner-${Date.now()}@openwork.test`,
    password: "OpenWork-proof-9274!suitable",
  };
  const web = await seed.web({ den, startPath: "/", headless: true, viewport: { width: 1280, height: 1200 } });
  return {
    den, web, owner,
    invitees: ["casey@openwork.test", "jordan@openwork.test"],
    rejectedEmail: "jordan@outside.test",
    async adoptSignedInOwner() {
      // Read witnesses use the same account that the user created through the UI.
      den.admin = await signIn(den.ref, owner);
    },
    async pathname() {
      const path = await seed.evalIn(web, "window.location.pathname");
      if (typeof path !== "string") throw new Error("Expected browser path");
      return path;
    },
  };
}

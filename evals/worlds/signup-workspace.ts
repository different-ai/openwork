import { signIn } from "@openwork/behaviors";
import { captureBrowserFilm } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

export async function signupWorkspace(seed: Seed, options: { simplified?: boolean; filmDirectory?: string; viewport?: { width: number; height: number } } = {}) {
  // Capture real rendered emails locally; never use an inherited mail provider.
  const den = await seed.den({ provision: options.simplified === true,
    ...(options.simplified ? { org: {
      name: "Existing workspace",
      admin: { name: "Existing Admin", email: `onboarding-admin-${Date.now()}@openwork.test` },
    } } : {}),
    env: {
    OPENWORK_DEV_MODE: "1", RESEND_API_KEY: "", SMTP_HOST: "",
    DEN_REQUIRE_EMAIL_VERIFICATION: "false",
    DEN_OPENWORK_WEB_ENABLED: "true",
    ...(options.simplified ? { DEN_DEPLOYMENT: "cloud" } : {}),
  } });
  const owner = {
    name: "Workspace Owner",
    email: `workspace-owner-${Date.now()}@openwork.test`,
    password: "OpenWork-proof-9274!suitable",
  };
  const web = await seed.web({ den, startPath: "/", headless: true, viewport: options.viewport ?? { width: 1600, height: 1000 } });
  const filmDirectory = options.filmDirectory ?? process.env.OPENWORK_EVAL_FILM_DIR;
  const film = filmDirectory ? await captureBrowserFilm(web, filmDirectory) : null;
  return {
    den, web, owner, film,
    async [Symbol.asyncDispose]() { await film?.stop(); },
    invitees: ["casey@openwork.test", "jordan@openwork.test"],
    rejectedEmail: "jordan@outside.test",
    async adoptSignedInOwner() {
      // Read witnesses use the same account that the user created through the UI.
      den.admin = await signIn(den.ref, owner);
    },
    async pathname() {
      const path = await seed.evalIn(web, () => (window.location.pathname));
      if (typeof path !== "string") throw new Error("Expected browser path");
      return path;
    },
  };
}

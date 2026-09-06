import type { Seed } from "@openwork/env";

export async function desktopTeam(seed: Seed) {
  const den = await seed.den({
    org: {
      name: `Desktop team ${Date.now()}`,
      admin: { name: "Team Owner" },
      members: { teammate: { name: "Team Member" } },
    },
    // Only the dev outbox should receive invitations from this journey.
    env: { RESEND_API_KEY: "", SMTP_HOST: "", EMAIL_FROM: "" },
  });
  if (!den.members.teammate) throw new Error("Team member fixture was not provisioned.");
  const app = await seed.desktop({ den, name: "team-owner" });
  const member = await seed.desktop({ den, as: "teammate", name: "team-member" });
  return { den, app, member, inviteEmail: `new-teammate-${Date.now()}@openwork.test` };
}

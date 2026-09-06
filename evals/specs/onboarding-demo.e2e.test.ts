import { spec } from "@openwork/testkit";
import { onboardingDemo } from "../worlds/onboarding-demo.ts";
import { createAccount, createWorkspace, addPeople, selectTools, downloadDesktop } from "../behaviors/onboarding-demo.ts";

// Dedicated linear recording journey. The comprehensive regression spec remains independent.
const test = spec.world(onboardingDemo, { timeout: 600_000 });
test("signup, invite two teammates, add tools, and download the desktop app", async (ctx) => {
  await createAccount(ctx);
  const orgId = await createWorkspace(ctx);
  await addPeople(ctx, orgId);
  await selectTools(ctx, orgId);
  await downloadDesktop(ctx);
});

import { typeField } from "@openwork/behaviors";
import type { SpecBodyContext } from "@openwork/testkit";
import type { onboardingWorld } from "./world.ts";

export type OnboardingContext = SpecBodyContext<
  Awaited<ReturnType<typeof onboardingWorld>>
>;

function records(body: unknown, key: string): Record<string, unknown>[] {
  if (typeof body !== "object" || body === null || !(key in body))
    throw new Error(`Missing ${key}`);
  const value: unknown = Reflect.get(body, key);
  if (!Array.isArray(value)) throw new Error(`Expected ${key} array`);
  return value.map((item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new Error(`Invalid ${key} entry`);
    return Object.fromEntries(Object.entries(item));
  });
}

export async function onboarding(ctx: OnboardingContext) {
  const { user, world, step, probe } = ctx;
  const read = async (path: string, orgId?: string) => {
    const result = await probe.api(
      world.den.admin,
      path,
      orgId ? { headers: { "x-openwork-org-id": orgId } } : {},
    );
    if (!result.response.ok)
      throw new Error(
        `Witness request failed: ${path} (${result.response.status})`,
      );
    return result.body;
  };

  await user.see({ text: "Good work starts here." }, { timeoutMs: 90_000 });
  await step("Enter email", () =>
    typeField(user, { role: "textbox", label: "Email" }, world.owner.email),
  );
  await step("Continue to account details", () =>
    user.click({ role: "button", label: "Next" }),
  );
  await step("Enter name", () =>
    typeField(user, { role: "textbox", label: "Name" }, world.owner.name),
  );
  await step("Enter password", () =>
    typeField(
      user,
      { role: "textbox", label: "Password" },
      world.owner.password,
      { sensitive: true },
    ),
  );
  await step("Create account", async () => {
    await user.click({ role: "button", label: "Sign up" });
    await user.see({ text: "Make it yours." }, { timeoutMs: 90_000 });
    await world.adoptSignedInOwner();
  });
  const organizationsBefore = records(await read("/v1/me/orgs"), "orgs");

  await step("Choose personal workspace", () =>
    user.click({ text: "On my own" }),
  );
  await step("Name workspace", () =>
    typeField(user, { role: "textbox", label: "Organization name" }, "Studio"),
  );
  await step("Create workspace", async () => {
    await user.click({ role: "button", label: "Continue" });
    await user.see({ text: "Bring your people." }, { timeoutMs: 90_000 });
  });
  const organizations = records(await read("/v1/me/orgs"), "orgs");
  const orgId = organizations[0]?.id;
  if (typeof orgId !== "string") throw new Error("Workspace has no id");

  for (const [index, email] of world.invitees.entries()) {
    await step(`Enter teammate ${index + 1}`, () =>
      typeField(
        user,
        {
          role: "textbox",
          label: `Teammate email ${index + 1}`,
        },
        email,
      ),
    );
  }
  await step("Send invitations", async () => {
    await user.click({ role: "button", label: "Send invitations" });
    await user.see({ text: "2 invitations sent." }, { timeoutMs: 90_000 });
  });
  const invitations = records(await read("/v1/org", orgId), "invitations");
  const emails = records(
    await read("/v1/dev/emails?template=organizationInvite"),
    "emails",
  );
  await step("Continue to tools", async () => {
    await user.click({ role: "button", label: "Continue" });
    await user.see(
      { text: "Give your team a head start." },
      { timeoutMs: 90_000 },
    );
  });

  for (const name of ["Notion", "Linear"]) {
    await step(`Select ${name}`, () =>
      user.click({ role: "checkbox", label: `Add ${name}` }),
    );
  }
  await step("Add selected tools", async () => {
    await user.click({ role: "button", label: "Add to team" });
    await user.see({ text: "Added to team" }, { timeoutMs: 90_000 });
  });
  const connections = records(
    await read("/v1/mcp-connections?scope=manageable", orgId),
    "connections",
  );
  await step("Continue to download", async () => {
    await user.click({ role: "button", label: "Continue" });
    await user.see(
      { role: "link", text: "Download for Linux" },
      { timeoutMs: 90_000 },
    );
  });

  const film = world.film;
  if (!film)
    throw new Error("The onboarding world must capture browser downloads");
  await step("Download OpenWork", () =>
    user.click({ role: "link", text: "Download for Linux" }),
  );
  const completed = await step("Download completes", () =>
    probe.eventually(
      () => film.downloads.find((event) => event.state === "completed"),
      { within: 180_000, label: "installer completed", until: Boolean },
    ),
  );
  return {
    organizationsBefore,
    organizations,
    invitations,
    emails,
    connections,
    completed,
    downloads: film.downloads,
  };
}

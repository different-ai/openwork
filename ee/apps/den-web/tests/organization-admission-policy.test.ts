import { expect, test } from "bun:test"

const root = new URL("../", import.meta.url)

test("organization settings use one admission policy surface with all standard presets", async () => {
  const settings = await Bun.file(new URL("app/(den)/dashboard/_components/org-settings-screen.tsx", root)).text()
  const card = await Bun.file(new URL("app/(den)/dashboard/_components/organization-admission-policy-card.tsx", root)).text()
  expect(settings).toContain("OrganizationAdmissionPolicyCard")
  expect(settings).not.toContain("Single sign-on requirement")
  for (const label of ["Open", "Domain restricted", "Invite only", "SSO JIT only", "SCIM managed + SSO", "Invite or SSO"]) {
    expect(card).toContain(label)
  }
  expect(card).toContain("Shadow mode")
  expect(card).toContain("Show advanced controls")
})

test("join flow supports organization slugs and every structured next step", async () => {
  const join = await Bun.file(new URL("app/(den)/_components/join-org-screen.tsx", root)).text()
  expect(join).toContain("organizationSlug")
  expect(join).toContain("require_email_verification")
  expect(join).toContain("require_invitation")
  expect(join).toContain("require_sso")
  expect(join).toContain("require_scim_provisioning")
  expect(join).toContain("Access was denied")
  expect(join).toContain('callbackUrl.searchParams.set("invite", invitationToken)')
  expect(join).toContain('callbackUrl.searchParams.set("slug", organizationSlug)')
})

test("member administration does not expose stored invitation tokens", async () => {
  const members = await Bun.file(new URL("app/(den)/dashboard/_components/manage-members-screen.tsx", root)).text()
  const orgTypes = await Bun.file(new URL("app/(den)/_lib/den-org.ts", root)).text()
  expect(members).not.toContain("Copy invite link")
  expect(orgTypes).not.toContain("inviteToken:")
  expect(members).toContain("SCIM managed")
})

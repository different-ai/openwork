import { beforeAll, expect, test } from "bun:test"
import { ORGANIZATION_ADMISSION_PRESETS } from "@openwork/types/den/organization-admission"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let admission: typeof import("../src/organization-admission.js")

beforeAll(async () => {
  seedRequiredEnv()
  admission = await import("../src/organization-admission.js")
})

test("enterprise admission presets map to composable standard controls", () => {
  expect(ORGANIZATION_ADMISSION_PRESETS.open).toMatchObject({
    admissionMethods: ["self_join", "invitation"],
    emailDomainRule: { mode: "any" },
    authenticationRequirement: "any",
    lifecycleAuthority: "local",
  })
  expect(ORGANIZATION_ADMISSION_PRESETS.domain_restricted.emailDomainRule.mode).toBe("allowlist")
  expect(ORGANIZATION_ADMISSION_PRESETS.invite_only.admissionMethods).toEqual(["invitation"])
  expect(ORGANIZATION_ADMISSION_PRESETS.sso_only).toMatchObject({
    admissionMethods: ["sso_jit"],
    authenticationRequirement: "organization_sso",
  })
  expect(ORGANIZATION_ADMISSION_PRESETS.scim_managed).toMatchObject({
    admissionMethods: ["scim"],
    authenticationRequirement: "organization_sso",
    lifecycleAuthority: "scim",
  })
  expect(ORGANIZATION_ADMISSION_PRESETS.invite_or_sso.admissionMethods).toEqual(["invitation", "sso_jit"])
})

test("domains are normalized exactly, including IDNs", () => {
  expect(admission.normalizeAdmissionDomain(" @Example.COM. ")).toBe("example.com")
  expect(admission.normalizeAdmissionDomain("bücher.example")).toBe("xn--bcher-kva.example")
  expect(admission.normalizeAdmissionDomain("sub.example.com")).toBe("sub.example.com")
  expect(admission.normalizeAdmissionDomain("example.com")).not.toBe("sub.example.com")
  expect(admission.normalizeAdmissionDomain("localhost")).toBeNull()
  expect(admission.normalizeAdmissionDomain("-bad.example")).toBeNull()
  expect(admission.normalizeAdmissionEmail(" User@BÜCHER.example ")).toBe("user@xn--bcher-kva.example")
})

test("domain lists reject malformed values and deduplicate normalized values", () => {
  expect(admission.normalizeAdmissionDomains(["Example.com", "example.com.", "bad_domain"])).toEqual({
    domains: ["example.com"],
    invalid: ["bad_domain"],
  })
})

test("invitation tokens are represented by deterministic SHA-256 hashes", () => {
  const token = "secret-one-use-token"
  const hash = admission.hashOrganizationInvitationToken(token)
  expect(hash).toHaveLength(64)
  expect(hash).toBe(admission.hashOrganizationInvitationToken(token))
  expect(hash).not.toContain(token)
  expect(hash).not.toBe(admission.hashOrganizationInvitationToken(`${token}-rotated`))
})

test("production membership bindings are structurally centralized", async () => {
  const glob = new Bun.Glob("src/**/*.ts")
  const violations: string[] = []
  for await (const file of glob.scan({ cwd: new URL("..", import.meta.url).pathname })) {
    if (file === "src/organization-admission.ts") continue
    const source = await Bun.file(new URL(`../${file}`, import.meta.url)).text()
    for (const match of source.matchAll(/(?:db|tx)\.insert\((?:schema\.)?MemberTable\)\.values\(\{([\s\S]*?)\n\s*\}\)/g)) {
      if (!/userId:\s*null/.test(match[1] ?? "")) violations.push(`${file}: user-backed insert`)
    }
    for (const match of source.matchAll(/update\((?:schema\.)?MemberTable\)([\s\S]{0,600}?)\.where/g)) {
      if (/\.set\(\{\s*userId(?:\s*:|\s*,)/.test(match[1] ?? "")) violations.push(`${file}: user binding update`)
    }
  }
  expect(violations).toEqual([])
})

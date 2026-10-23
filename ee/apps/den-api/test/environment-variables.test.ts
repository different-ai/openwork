import assert from "node:assert/strict"
import { test } from "node:test"
import { environmentVariableKeyProblem } from "@openwork/types/den/environment-variables"
import { memberReceivesEnvironmentVariable, nextStoredValue, resolveEnvironmentVariableValue, type EnvironmentVariableAccessEntry } from "../src/environment-variables/resolve.ts"

const member = { id: "om_me", teams: [{ id: "tem_sales", name: "Sales" }, { id: "tem_design", name: "Design" }] }
const everyone: EnvironmentVariableAccessEntry = { id: "eva_all", orgMembershipId: null, teamId: null, value: "everyone-value" }
const sales: EnvironmentVariableAccessEntry = { id: "eva_sales", orgMembershipId: null, teamId: "tem_sales", value: "sales-value" }
const design: EnvironmentVariableAccessEntry = { id: "eva_design", orgMembershipId: null, teamId: "tem_design", value: "design-value" }
const direct: EnvironmentVariableAccessEntry = { id: "eva_me", orgMembershipId: "om_me", teamId: null, value: "direct-value" }

function resolve(access: EnvironmentVariableAccessEntry[], selectedAccessId: string | null = null) {
  return resolveEnvironmentVariableValue({ valueMode: "admin", access, member, organizationName: "Acme", ownValue: null, selectedAccessId })
}

test("a member receives a variable assigned to them, one of their teams, or everyone", () => {
  assert.equal(memberReceivesEnvironmentVariable([direct], member), true)
  assert.equal(memberReceivesEnvironmentVariable([sales], member), true)
  assert.equal(memberReceivesEnvironmentVariable([everyone], member), true)
  assert.equal(memberReceivesEnvironmentVariable([{ id: "x", orgMembershipId: "om_other", teamId: null, value: null }, { id: "y", orgMembershipId: null, teamId: "tem_ops", value: null }], member), false)
})

test("the most specific assignment wins by default: directly to you, then teams by name, then everyone", () => {
  assert.equal(resolve([everyone, sales, design, direct]).value, "direct-value")
  const teams = resolve([everyone, sales, design])
  assert.equal(teams.value, "design-value")
  assert.equal(teams.source, "team")
  assert.deepEqual(teams.assignments.map((entry) => entry.label), ["Design", "Sales", "Everyone in Acme"])
  assert.equal(resolve([everyone]).source, "everyone")
})

test("the person can choose another assignment, and a stale choice falls back to the default", () => {
  const chosen = resolve([everyone, sales, direct], "eva_all")
  assert.equal(chosen.value, "everyone-value")
  assert.equal(chosen.selectedAccessId, "eva_all")
  assert.deepEqual(chosen.assignments.map((entry) => entry.label), ["Directly to you", "Sales", "Everyone in Acme"])
  assert.equal(resolve([everyone, sales], "eva_gone").value, "sales-value")
})

test("assignments without a value are not offered", () => {
  const result = resolve([{ ...direct, value: null }, everyone])
  assert.equal(result.value, "everyone-value")
  assert.deepEqual(result.assignments.map((entry) => entry.accessId), ["eva_all"])
  assert.equal(resolve([{ ...everyone, value: null }]).value, null)
})

test("per-member variables only ever use the member's own value", () => {
  const own = resolveEnvironmentVariableValue({ valueMode: "per_member", access: [everyone], member, organizationName: "Acme", ownValue: "mine", selectedAccessId: "eva_all" })
  assert.equal(own.value, "mine")
  assert.equal(own.source, "own")
  assert.deepEqual(own.assignments, [])
  assert.equal(resolveEnvironmentVariableValue({ valueMode: "per_member", access: [everyone], member, organizationName: "Acme", ownValue: null, selectedAccessId: null }).value, null)
})

test("writes keep, clear or replace a stored value", () => {
  assert.equal(nextStoredValue("old", undefined), "old")
  assert.equal(nextStoredValue("old", null), null)
  assert.equal(nextStoredValue("old", ""), null)
  assert.equal(nextStoredValue(null, "new"), "new")
})

test("keys the desktop owns can't be deployed", () => {
  assert.equal(environmentVariableKeyProblem("GITHUB_TOKEN"), null)
  assert.equal(environmentVariableKeyProblem("_private"), null)
  assert.match(environmentVariableKeyProblem("PATH") ?? "", /used by the desktop/)
  assert.match(environmentVariableKeyProblem("OPENWORK_API_KEY") ?? "", /reserved/)
  assert.match(environmentVariableKeyProblem("opencode_config") ?? "", /reserved/)
  assert.match(environmentVariableKeyProblem("1BAD") ?? "", /letters/)
  assert.equal(environmentVariableKeyProblem(""), "Enter a key.")
})

test("keys that make programs run other commands can't be deployed", () => {
  for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_SSH_COMMAND", "git_askpass", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES",
    "BASH_ENV", "PROMPT_COMMAND", "PYTHONSTARTUP", "PERL5OPT", "JAVA_TOOL_OPTIONS", "npm_config_script_shell", "BASH_FUNC_x%%", "EDITOR", "TAR_OPTIONS", "tar_options", "MAKEFLAGS", "RSYNC_RSH", "PS1", "VIMINIT", "EXINIT", "viminit", "NVIM_APPNAME", "NODE_TLS_REJECT_UNAUTHORIZED", "SSLKEYLOGFILE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"]) {
    assert.notEqual(environmentVariableKeyProblem(key), null, key)
  }
  for (const key of ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "HTTPS_PROXY", "COMPANY_API_URL", "SENTRY_DSN"]) {
    assert.equal(environmentVariableKeyProblem(key), null, key)
  }
})

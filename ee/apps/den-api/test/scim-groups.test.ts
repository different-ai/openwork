import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let applyScimGroupPatch: typeof import("../src/scim-groups.js").applyScimGroupPatch
let shouldDeleteGlobalUser: typeof import("../src/scim-deprovisioning.js").shouldDeleteGlobalUser

beforeAll(async () => {
  seedRequiredEnv()
  const [groups, deprovisioning] = await Promise.all([
    import("../src/scim-groups.js"),
    import("../src/scim-deprovisioning.js"),
  ])
  applyScimGroupPatch = groups.applyScimGroupPatch
  shouldDeleteGlobalUser = deprovisioning.shouldDeleteGlobalUser
})

test("SCIM group PATCH adds and removes members without replacing unrelated members", () => {
  const added = applyScimGroupPatch({
    current: {
      displayName: "Engineering",
      members: [{ value: "usr_one" }, { value: "usr_two" }],
    },
    operations: [{ op: "add", path: "members", value: [{ value: "usr_three" }] }],
  })

  expect(added.members?.map((member) => member.value)).toEqual(["usr_one", "usr_two", "usr_three"])

  const removed = applyScimGroupPatch({
    current: added,
    operations: [{ op: "remove", path: 'members[value eq "usr_two"]' }],
  })
  expect(removed.members?.map((member) => member.value)).toEqual(["usr_one", "usr_three"])
})

test("SCIM group PATCH replaces group metadata and membership", () => {
  const result = applyScimGroupPatch({
    current: { displayName: "Old name", externalId: "old", members: [{ value: "usr_old" }] },
    operations: [{
      op: "replace",
      value: {
        displayName: "Design",
        externalId: "design-group",
        members: [{ value: "usr_designer" }],
      },
    }],
  })

  expect(result).toEqual({
    displayName: "Design",
    externalId: "design-group",
    members: [{ value: "usr_designer" }],
  })
})

test("global users are deleted only after their final active organization membership is removed", () => {
  expect(shouldDeleteGlobalUser(0)).toBe(true)
  expect(shouldDeleteGlobalUser(1)).toBe(false)
  expect(shouldDeleteGlobalUser(2)).toBe(false)
})

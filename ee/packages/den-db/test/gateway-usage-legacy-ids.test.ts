import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import {
  denTypeIdFromLegacyUuid,
  isDenTypeId,
  isLegacyUuid,
  normalizeDenTypeIdOrLegacyUuid,
} from "@openwork-ee/utils/typeid"
import {
  GatewayUsageBucketTable,
  GatewayUsagePolicyTable,
} from "../src/schema/gateway-usage-limits"
import { legacyUuidOf } from "./legacy-uuid-fixture"

test("legacy UUIDs convert to the TypeID holding the same 128 bits", () => {
  const known: [string, string][] = [
    ["00000000-0000-0000-0000-000000000000", "gulp_00000000000000000000000000"],
    ["ffffffff-ffff-ffff-ffff-ffffffffffff", "gulp_7zzzzzzzzzzzzzzzzzzzzzzzzz"],
    ["01890a5d-ac96-774b-bcce-b302099a8057", "gulp_01h455vb4pex5vsknk084sn02q"],
  ]
  for (const [uuid, typeId] of known) {
    assert.equal(denTypeIdFromLegacyUuid("gatewayUsagePolicy", uuid), typeId)
    assert.equal(legacyUuidOf(typeId), uuid)
  }
  for (let i = 0; i < 200; i++) {
    const uuid = randomUUID()
    const typeId = denTypeIdFromLegacyUuid("gatewayUsageResetRequest", uuid)
    assert.ok(isDenTypeId("gatewayUsageResetRequest", typeId))
    assert.equal(legacyUuidOf(typeId), uuid)
    assert.equal(denTypeIdFromLegacyUuid("gatewayUsageResetRequest", uuid.toUpperCase()), typeId)
  }
})

test("legacy UUID detection only matches UUID-shaped values", () => {
  assert.ok(isLegacyUuid(randomUUID()))
  for (const value of [
    "unlimited",
    "gulp_01h455vb4pex5vsknk084sn02q",
    randomUUID().replaceAll("-", ""),
    `history:${randomUUID()}`,
    "",
  ])
    assert.equal(isLegacyUuid(value), false)
  assert.throws(() => denTypeIdFromLegacyUuid("gatewayUsagePolicy", "unlimited"))
  assert.throws(() => normalizeDenTypeIdOrLegacyUuid("gatewayUsagePolicy", "om_01h455vb4pex5vsknk084sn02q"))
})

test("legacy-tolerant columns read and write legacy UUIDs as TypeIDs", () => {
  const uuid = randomUUID()
  const typeId = denTypeIdFromLegacyUuid("gatewayUsagePolicy", uuid)
  const column = GatewayUsagePolicyTable.id
  assert.equal(column.mapFromDriverValue(uuid), typeId)
  assert.equal(column.mapFromDriverValue(typeId), typeId)
  assert.equal(column.mapToDriverValue(typeId), typeId)
  // A legacy UUID used as a query parameter or insert value is stored as a TypeID.
  assert.equal(column.mapToDriverValue(denTypeIdFromLegacyUuid("gatewayUsagePolicy", uuid)), typeId)
  assert.throws(() => column.mapFromDriverValue("unlimited"))

  const snapshot = GatewayUsageBucketTable.policyId
  assert.equal(snapshot.mapFromDriverValue("unlimited"), "unlimited")
  assert.equal(snapshot.mapToDriverValue("unlimited"), "unlimited")
  assert.equal(snapshot.mapFromDriverValue(uuid), typeId)
  assert.throws(() => snapshot.mapFromDriverValue("gula_01h455vb4pex5vsknk084sn02q"))
})

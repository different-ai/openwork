import test from "node:test";
import assert from "node:assert/strict";
import { workshopRunIdentity } from "./workshop-run-identity.ts";

test("native and paired runners share stable committed-source and prompt identities without inference", async () => {
  const first = await workshopRunIdentity();
  assert.match(first.gitSha, /^[a-f0-9]{40}$/);
  assert.match(first.sourceDigest, /^[a-f0-9]{64}$/);
  assert.match(first.promptDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await workshopRunIdentity(), first);
});

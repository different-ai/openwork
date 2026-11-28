import assert from "node:assert/strict";
import test from "node:test";
import { readComputersMachineKey, readDesktopMachineId } from "./desktop-machine-id.mjs";

const uuid = "51dacd51-f384-49a0-91ce-0768e397349e";
const mac = (value) => ({ exec: async () => ({ stdout: `"IOPlatformUUID" = "${value}"` }) });

test("Computers derives a stable lowercase hex key from the normalized machine id", async () => {
  const key = await readComputersMachineKey("darwin", mac(uuid));
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, await readComputersMachineKey("darwin", mac(` ${uuid.toUpperCase()} `)));
  assert.notEqual(key, await readComputersMachineKey("darwin", mac("be4a431e-4bb3-4602-95df-2261d1605394")));
});

test("Computers and Free Inference derive different identifiers for the same machine", async () => {
  assert.notEqual(await readComputersMachineKey("darwin", mac(uuid)), await readDesktopMachineId("darwin", mac(uuid)));
});

test("Computers returns no key when the machine id is missing, invalid, or unreadable", async () => {
  assert.equal(await readComputersMachineKey("darwin", { exec: async () => ({ stdout: "" }) }), null);
  assert.equal(await readComputersMachineKey("darwin", mac("00000000-0000-0000-0000-000000000000")), null);
  assert.equal(await readComputersMachineKey("darwin", { exec: async () => { throw new Error("Read failed"); } }), null);
});

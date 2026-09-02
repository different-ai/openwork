import { createServer } from "node:net";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { testkitAppBootWorld } from "../worlds/first-run.ts";

const test = spec.world(testkitAppBootWorld, { needs: { placement: "local" } });

function portCanBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

test("testkit boots a local Den and signed-in app with ambient evidence", async ({ world, user }) => {
  await user.looks(["The OpenWork workspace shell is visible and ready for a task"]);
  const { api, web } = world.ports;
  await world.close();
  expect(await portCanBind(api)).toBe(true);
  expect(await portCanBind(web)).toBe(true);
});

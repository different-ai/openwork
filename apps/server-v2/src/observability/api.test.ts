import { afterEach, expect, test } from "bun:test";
import { getOtelApi, resetOtelApiCacheForTesting } from "./api.js";

afterEach(() => {
  resetOtelApiCacheForTesting();
});

test("getOtelApi caches the import promise across concurrent callers", () => {
  const first = getOtelApi();
  const second = getOtelApi();
  expect(first).toBe(second);
});

test("getOtelApi resolves without throwing when the optional dep is absent", async () => {
  const api = await getOtelApi();
  expect(typeof api === "object").toBe(true);
});

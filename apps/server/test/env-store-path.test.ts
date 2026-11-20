import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { join } from "node:path";
import { openworkEnvStorePath } from "@openwork/paths";
import { resolveDefaultEnvStorePath } from "../src/env-file.js";
import type { ServerConfig } from "../src/types.js";

const previous = process.env.OPENWORK_ENV_STORE;
afterEach(() => {
  if (previous === undefined) delete process.env.OPENWORK_ENV_STORE;
  else process.env.OPENWORK_ENV_STORE = previous;
});

const configAt = (configPath: string) => ({ configPath }) as ServerConfig;

test("the env store sits beside a --config server config", () => {
  delete process.env.OPENWORK_ENV_STORE;
  const dir = join("/", "tmp", "openwork-profile");
  assert.equal(resolveDefaultEnvStorePath(configAt(join(dir, "server.json"))), join(dir, "env.json"));
});

test("OPENWORK_ENV_STORE still wins over the config directory", () => {
  const override = join("/", "tmp", "elsewhere", "env.json");
  process.env.OPENWORK_ENV_STORE = override;
  assert.equal(resolveDefaultEnvStorePath(configAt(join("/", "tmp", "openwork-profile", "server.json"))), override);
});

test("without a config path the default store is used", () => {
  delete process.env.OPENWORK_ENV_STORE;
  assert.equal(resolveDefaultEnvStorePath(), openworkEnvStorePath());
});

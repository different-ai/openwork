import { defineConfig } from "@hey-api/openapi-ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  input: resolve(configDir, "../../apps/server-v2/openapi/openapi.json"),
  output: resolve(configDir, "generated"),
});

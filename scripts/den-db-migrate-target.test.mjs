import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(new URL("../.github/workflows/den-db-migrate.yml", import.meta.url), "utf8");
const root = new URL("../", import.meta.url);

function stepScript(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `Missing step: ${name}`);
  const run = workflow.indexOf("        run: |\n", start);
  assert.notEqual(run, -1, `Missing script: ${name}`);
  const lines = workflow.slice(run + "        run: |\n".length).split("\n");
  const end = lines.findIndex((line) => line.trim() && !line.startsWith("          "));
  return lines.slice(0, end === -1 ? undefined : end).map((line) => line.slice(10)).join("\n");
}

test("SQL schema and PlanetScale API database are configured separately", () => {
  assert.match(workflow, /^      DATABASE_NAME: \$\{\{ secrets\.DATABASE_NAME \}\}$/m);
  assert.match(workflow, /^      PLANETSCALE_DATABASE: openwork-den$/m);
  assert.match(workflow, /^      PLANETSCALE_ORG: different-ai$/m);
});

for (const [name, action] of [
  ["Disable safe migrations (allow DDL for this run only)", "disable"],
  ["Re-enable safe migrations", "enable"],
]) {
  test(`${action} safe migrations uses the API slug, not the SQL schema`, () => {
    // Execute the actual workflow shell blocks; all external writes and waits
    // are mocked. Distinct names reproduce the CI configuration that failed.
    const result = spawnSync("bash", ["-c", `
      pscale() {
        if [[ "$*" != 'branch safe-migrations ${action} openwork-den main --org different-ai --format json' ]]; then
          echo "Wrong PlanetScale target" >&2
          return 2
        fi
        printf '{"safe_migrations":${action === "enable"}}\\n'
      }
      node() { return 0; }
      sleep() { return 0; }
      ${stepScript(name)}
    `], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_NAME: "sql-schema-not-api-slug",
        PLANETSCALE_DATABASE: "openwork-den",
        PLANETSCALE_ORG: "different-ai",
        PLANETSCALE_BRANCH: "main",
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, action === "enable"
      ? /PlanetScale confirmed safe migrations are enabled/
      : /Safe migrations disabled for the duration of this run/);
  });
}

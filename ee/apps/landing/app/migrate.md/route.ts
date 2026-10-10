import { readFileSync } from "node:fs";
import { join } from "node:path";

export const dynamic = "force-static";

// The agent guide for moving from Claude Cowork, read from the same package as
// the openwork-bootstrap CLI it drives so the two cannot drift apart.
function readMigrateGuide() {
  return readFileSync(join(process.cwd(), "..", "..", "..", "packages", "openwork-bootstrap", "migrate.md"), "utf8");
}

export function GET() {
  return new Response(readMigrateGuide(), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
}

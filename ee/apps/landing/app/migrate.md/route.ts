import { readFileSync } from "node:fs";
import { join } from "node:path";

export const dynamic = "force-static";

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

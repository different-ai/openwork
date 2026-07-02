import { readFileSync } from "node:fs";
import { join } from "node:path";

export const dynamic = "force-static";

function readBootstrapCli() {
  return readFileSync(join(process.cwd(), "..", "..", "..", "packages", "openwork-bootstrap", "bin", "openwork.mjs"), "utf8");
}

export function GET() {
  return new Response(readBootstrapCli(), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
}

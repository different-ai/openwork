import { execSync } from "node:child_process";

execSync("pnpm --filter @openwork/desktop build", { stdio: "inherit" });

import { execSync } from "node:child_process";

execSync("pnpm --filter @micx/desktop build", { stdio: "inherit" });

import { execSync } from "node:child_process";

const isVercel = Boolean(process.env.VERCEL);
const command = isVercel
  ? "pnpm --dir services/openwork-share run build"
  : "pnpm --filter @different-ai/openwork build";

execSync(command, { stdio: "inherit" });

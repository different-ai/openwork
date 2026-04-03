import { spawn } from "node:child_process";

const vite = spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", "4174", "--strictPort"], {
  stdio: "inherit",
});

let done = false;

function shutdown(code = 0) {
  if (done) return;
  done = true;
  vite.kill();
  process.exit(code);
}

vite.on("exit", (code) => {
  if (!done) shutdown(code ?? 1);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

setTimeout(() => {
  const electron = spawn(
    "pnpm",
    ["exec", "electron", "./dist-electron/main.js"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        OPENWORK_LABS_DEV: "1",
        OPENWORK_LABS_RENDERER_URL: "http://127.0.0.1:4174",
      },
    },
  );

  electron.on("exit", (code) => shutdown(code ?? 0));
}, 2500);

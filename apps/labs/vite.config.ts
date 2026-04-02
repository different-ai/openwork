import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk/v2";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

const localUrl = "http://127.0.0.1:4096";

let runtime: Awaited<ReturnType<typeof createOpencode>> | null = null;
let boot: Promise<void> | null = null;

async function ensureLocalServer() {
  if (boot) return boot;
  boot = (async () => {
    try {
      const client = createOpencodeClient({ baseUrl: localUrl });
      await client.global.health();
      return;
    } catch {
      runtime = await createOpencode({ port: 4096 });
    }
  })();

  try {
    await boot;
  } finally {
    boot = null;
  }
}

function ensureLocalOpencodePlugin(): Plugin {
  return {
    name: "ensure-local-opencode",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      void ensureLocalServer().catch((error) => {
        server.config.logger.error(
          `Failed to start local OpenCode server: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      server.httpServer?.once("close", () => {
        runtime?.server.close();
        runtime = null;
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), ensureLocalOpencodePlugin()],
  server: {
    host: "0.0.0.0",
    port: 3340,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 3340,
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
});

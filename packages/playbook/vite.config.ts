import os from "node:os";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";

const hostname = os.hostname();
const shortHostname = hostname.split(".")[0];
const allowedHosts = [hostname, shortHostname].filter(Boolean);

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  server: {
    port: 4173,
    strictPort: true,
    allowedHosts,
  },
  build: {
    target: "esnext",
  },
});

import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";

const portValue = Number.parseInt(process.env.PORT ?? "", 10);
const devPort = Number.isFinite(portValue) && portValue > 0 ? portValue : 5173;

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  server: {
    port: devPort,
    strictPort: true,
  },
  build: {
    target: "esnext",
  },
});

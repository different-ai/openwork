import { Hono } from "hono";
import { registerSystemRoutes } from "./routes/system.js";

export function createV2App() {
  const app = new Hono();

  registerSystemRoutes(app);

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  return app;
}

export const v2App = createV2App();

export type V2AppType = typeof v2App;

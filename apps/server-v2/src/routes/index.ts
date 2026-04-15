import type { Hono } from "hono";
import type { AppDependencies } from "../context/app-dependencies.js";
import type { AppBindings } from "../context/request-context.js";
import { registerSystemRoutes } from "./system.js";

export function registerRoutes(app: Hono<AppBindings>, dependencies: AppDependencies) {
  registerSystemRoutes(app, dependencies);
}

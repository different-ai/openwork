import type { Env, Hono } from "hono"
import { registerGithubWebhookRoutes } from "./github.js"
import { registerStripeWebhookRoutes } from "./stripe.js"
import { registerTelegramWebhookRoutes } from "./telegram.js"

export function registerWebhookRoutes<T extends Env>(app: Hono<T>) {
  registerGithubWebhookRoutes(app)
  registerStripeWebhookRoutes(app)
  registerTelegramWebhookRoutes(app)
}

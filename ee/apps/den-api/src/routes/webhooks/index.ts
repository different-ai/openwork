import type { Env, Hono } from "hono"
import { registerGithubWebhookRoutes } from "./github.js"
import { registerStripeWebhookRoutes } from "./stripe.js"
import { registerTelegramWebhookRoutes } from "./telegram.js"
import { registerTagSlackWebhookRoutes } from "./tag-slack.js"

export function registerWebhookRoutes<T extends Env>(app: Hono<T>) {
  registerGithubWebhookRoutes(app)
  registerStripeWebhookRoutes(app)
  registerTagSlackWebhookRoutes(app)
  registerTelegramWebhookRoutes(app)
}

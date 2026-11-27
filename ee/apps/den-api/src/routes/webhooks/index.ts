import { registerOpenAiSafetyWebhook } from "./openai-safety.js"
import type { Env, Hono } from "hono"
import { registerCloudCodingGithubWebhook } from "./cloud-coding-github.js"
import { registerGithubWebhookRoutes } from "./github.js"
import { registerStripeWebhookRoutes } from "./stripe.js"

export function registerWebhookRoutes<T extends Env>(app: Hono<T>) {
  registerOpenAiSafetyWebhook(app)
  registerGithubWebhookRoutes(app)
  registerCloudCodingGithubWebhook(app)
  registerStripeWebhookRoutes(app)
}

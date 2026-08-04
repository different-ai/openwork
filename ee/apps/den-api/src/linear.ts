import { env } from "./env.js"
import {
  completeLinearIssue as completeLinearIssueWithConfig,
  createLinearIssue as createLinearIssueWithConfig,
} from "./linear-client.js"
import type { CompleteLinearIssueInput, CreateLinearIssueInput } from "./linear-client.js"

export type { CompleteLinearIssueInput, CreateLinearIssueInput, LinearConfig, LinearIssue } from "./linear-client.js"

export function createLinearIssue(input: CreateLinearIssueInput) {
  return createLinearIssueWithConfig(input, env.linear)
}

export function completeLinearIssue(input: CompleteLinearIssueInput) {
  return completeLinearIssueWithConfig(input, env.linear)
}

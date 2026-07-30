import { appLogger } from "./observability/logger.js"

export type LinearConfig = {
  apiKey?: string
  teamId?: string
  apiBase: string
  completedStateId?: string
}

export type LinearIssue = {
  id: string
  identifier?: string
  url?: string
}

export type CreateLinearIssueInput = {
  title: string
  description: string
  teamId?: string
  stateId?: string
  labelIds?: string[]
  priority?: number
}

export type CompleteLinearIssueInput = {
  issueId: string
  completedStateId?: string
}

const logger = appLogger.child({ component: "linear" })

const ISSUE_CREATE_MUTATION = `
mutation OpenWorkIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      url
    }
  }
}`

const ISSUE_COMPLETE_MUTATION = `
mutation OpenWorkIssueComplete($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      id
      identifier
      url
    }
  }
}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function parseJson(text: string): unknown {
  if (!text.trim()) {
    return null
  }
  return JSON.parse(text)
}

function graphqlErrorMessages(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.errors)) {
    return []
  }

  const messages: string[] = []
  for (const error of payload.errors) {
    if (isRecord(error) && typeof error.message === "string" && error.message.trim()) {
      messages.push(error.message)
    }
  }
  return messages
}

function recordField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key]
  return isRecord(value) ? value : null
}

function parseLinearIssue(value: unknown): LinearIssue | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    return null
  }

  return {
    id: value.id,
    identifier: optionalString(value.identifier),
    url: optionalString(value.url),
  }
}

async function linearGraphql(config: LinearConfig, query: string, variables: Record<string, unknown>) {
  const apiKey = config.apiKey?.trim()
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY is not configured")
  }

  const apiBase = config.apiBase.trim()
  if (!apiBase) {
    throw new Error("LINEAR_API_BASE is empty")
  }

  const response = await fetch(apiBase, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  })
  const text = await response.text()
  const payload = parseJson(text)

  if (!response.ok) {
    throw new Error(`Linear GraphQL request failed (${response.status}): ${text.slice(0, 400)}`)
  }

  const errors = graphqlErrorMessages(payload)
  if (errors.length > 0) {
    throw new Error(`Linear GraphQL error: ${errors.join("; ")}`)
  }

  return payload
}

async function createLinearIssueStrict(input: CreateLinearIssueInput & { teamId: string }, config: LinearConfig) {
  const issueInput: Record<string, unknown> = {
    teamId: input.teamId,
    title: input.title,
    description: input.description,
  }
  if (input.stateId) {
    issueInput.stateId = input.stateId
  }
  if (input.labelIds?.length) {
    issueInput.labelIds = input.labelIds
  }
  if (input.priority !== undefined) {
    issueInput.priority = input.priority
  }

  const payload = await linearGraphql(config, ISSUE_CREATE_MUTATION, { input: issueInput })
  const data = recordField(isRecord(payload) ? payload : null, "data")
  const issueCreate = recordField(data, "issueCreate")
  if (issueCreate?.success !== true) {
    return null
  }
  return parseLinearIssue(issueCreate.issue)
}

async function completeLinearIssueStrict(input: { issueId: string; completedStateId: string }, config: LinearConfig) {
  const payload = await linearGraphql(config, ISSUE_COMPLETE_MUTATION, {
    id: input.issueId,
    input: { stateId: input.completedStateId },
  })
  const data = recordField(isRecord(payload) ? payload : null, "data")
  const issueUpdate = recordField(data, "issueUpdate")
  return issueUpdate?.success === true
}

export async function createLinearIssue(input: CreateLinearIssueInput, config: LinearConfig): Promise<LinearIssue | null> {
  const teamId = input.teamId ?? config.teamId
  if (!config.apiKey || !teamId) {
    return null
  }

  try {
    return await createLinearIssueStrict({ ...input, teamId }, config)
  } catch (error) {
    logger.warn("failed to create Linear issue", { error })
    return null
  }
}

export async function completeLinearIssue(input: CompleteLinearIssueInput, config: LinearConfig) {
  const issueId = input.issueId.trim()
  const completedStateId = input.completedStateId ?? config.completedStateId
  if (!config.apiKey || !completedStateId || !issueId) {
    return false
  }

  try {
    return await completeLinearIssueStrict({ issueId, completedStateId }, config)
  } catch (error) {
    logger.warn("failed to complete Linear issue", { error, issue_id: issueId })
    return false
  }
}

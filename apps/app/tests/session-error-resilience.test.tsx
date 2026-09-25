import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { UIMessage } from "ai"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { PlatformProvider, createDefaultPlatform } from "../src/react-app/kernel/platform"

import { MessageList } from "../src/components/chat/message-list"
import { TaskRecovery } from "../src/components/chat/task-recovery"
import { MessageListProvider } from "../src/components/chat/message-list-provider"
import { getReactQueryClient } from "../src/react-app/infra/query-client"
import { createSessionErrorUIMessage } from "../src/react-app/domains/session/sync/usechat-adapter"
import {
  presentOpencodeSessionError,
  sessionErrorPresentationFromUIMessage,
} from "../src/react-app/domains/session/sync/session-error"
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  trackWorkspaceSessionSync,
  transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync"

afterEach(() => {
  getReactQueryClient().clear()
})

test("the quiet retry control preserves the recovery callback and disabled state", async () => {
  const registered = typeof window === "undefined"
  if (registered) GlobalRegistrator.register({ url: "http://localhost/" })
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const retry = mock(() => undefined)
  try {
    await act(async () => root.render(<TaskRecovery state="paused" title="Response interrupted" onRetry={retry} />))
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Retry task"]')
    if (!button) throw new Error("Missing retry control")
    expect(button.textContent).toBe("")
    await act(async () => { button.focus(); button.click() })
    expect(retry).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<TaskRecovery state="paused" title="Response interrupted" onRetry={retry} retryDisabled />))
    expect(button.disabled).toBe(true)
    await act(async () => button.click())
    expect(retry).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    if (registered) GlobalRegistrator.unregister()
  }
})

describe("session error resilience", () => {
  test.each([
    { name: "APIError", data: { message: "Too Many Requests", statusCode: 429 }, kind: "rate-limited", title: "This model is receiving too many requests" },
    { name: "APIError", data: { message: "invalid_api_key", statusCode: 401 }, kind: "provider-credentials", title: "Your API key wasn’t accepted" },
    { name: "ContextOverflowError", data: { message: "Prompt too long" }, kind: "conversation-too-long", title: "This conversation is too long for the model" },
    { name: "StructuredOutputError", data: { message: "Failed to parse output" }, kind: "output-invalid", title: "The model couldn’t finish a usable response" },
    { name: "MessageOutputLengthError", data: { message: "output limit" }, kind: "output-limit", title: "The response reached the model’s length limit" },
    { name: "TimeoutError", data: { message: "The operation was aborted due to timeout" }, kind: "provider-timeout", title: "Provider did not respond in time" },
    { name: "APIError", data: { message: "fetch failed", code: "ENOTFOUND" }, kind: "network-unavailable", title: "Can’t reach the model service" },
    { name: "APIError", data: { message: "file part media type application/pdf not supported", statusCode: 400 }, kind: "attachment-unsupported", title: "This model can’t read an attached file" },
  ])("explains $kind and retains the original error in details", ({ name, data, kind, title }) => {
    const result = presentOpencodeSessionError({ name, data })
    expect(result.kind).toBe(kind)
    expect(result.title).toBe(title)
    expect(result.description).toBeTruthy()
    expect(result.technicalDetails).toContain(data.message)
    if (["provider-credentials", "conversation-too-long", "attachment-unsupported"].includes(kind)) expect(result.recoveryPrompt).toBeNull()
  })

  test("an explicit Stop is not mistaken for a timeout mentioned by the provider", () => {
    expect(presentOpencodeSessionError({ name: "MessageAbortedError", data: { message: "aborted due to timeout" } }).kind).toBe("aborted")
  })
  const freeTierFailure = {
    name: "APIError",
    data: {
      message: "Error from provider (Console): Rate limit exceeded. Please try again later.",
      statusCode: 429,
      isRetryable: true,
      responseBody: '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Error from provider (Console): Rate limit exceeded. Please try again later."}}',
    },
  }

  test("classifies the free starter model limit while retaining developer details", () => {
    const presentation = presentOpencodeSessionError(freeTierFailure)

    expect(presentation.kind).toBe("free-model-limit")
    expect(presentation.title).toBe("The free starter model is busy right now")
    expect(presentation.description).toContain("connect your own model provider")
    expect(presentation.recoveryPrompt).toBeNull()
    expect(presentation.technicalDetails).toContain("429")
    expect(presentation.technicalDetails).toContain("FreeUsageLimitError")
  })

  test.each(["ENOSPC", "EDQUOT", "SQLITE_FULL", "database or disk is full"])("explains %s without exposing the stack trace", (code) => {
    const raw = `effect/sql/SqlError: Failed to execute statement\n at runLoop (/$bunfs/root/chunk.js:25:2045)\n${code}`
    const presentation = presentOpencodeSessionError({ name: "SqlError", data: { message: raw } })
    expect(presentation.kind).toBe("disk-full")
    expect(presentation.title).toBe("Storage error reported")
    expect(presentation.description).toBe("A storage limit was reported by the task runtime or a connected service. This does not necessarily mean your computer is full. Check the affected service or workspace before freeing local disk space.")
    expect(presentation.technicalDetails).toContain(code)
    expect(presentation.technicalDetails).toContain("at runLoop")
    expect(presentation.recoveryPrompt).toBeNull()
  })

  test("reads disk-full codes from native errors and nested causes", () => {
    for (const error of [
      Object.assign(new Error("write failed"), { code: "ENOSPC" }),
      { name: "SqlError", message: "Failed to execute statement", cause: { code: "SQLITE_FULL" } },
    ]) {
      expect(presentOpencodeSessionError(error).kind).toBe("disk-full")
    }
  })

  test("an upstream response-body storage code does not diagnose the local computer", () => {
    const presentation = presentOpencodeSessionError({
      name: "APIError",
      data: {
        message: "Connected service could not save the task output",
        statusCode: 507,
        responseBody: JSON.stringify({ error: { code: "EDQUOT", message: "Connected service storage quota exceeded" } }),
      },
    })
    expect(presentation.kind).toBe("disk-full")
    expect(presentation.title).toBe("Storage error reported")
    expect(presentation.description).toContain("does not necessarily mean your computer is full")
    expect(presentation.technicalDetails).toContain("EDQUOT")
    expect(presentation.technicalDetails).toContain("507")
  })

  test("does not diagnose a generic database failure as a full disk", () => {
    const presentation = presentOpencodeSessionError("effect/sql/SqlError: Failed to execute statement\n at runLoop (/$bunfs/root/chunk.js:25:2045)")
    expect(presentation.kind).toBe("database-error")
    expect(presentation.title).toBe("OpenWork couldn’t access its saved data")
    expect(presentation.description).toContain("check the available disk space")
    expect(presentation.description).not.toContain("has run out")
  })

  test("classifies an OpenCode abort and retains its diagnostic payload", () => {
    const presentation = presentOpencodeSessionError({
      name: "MessageAbortedError",
      data: {
        message: "Aborted",
        providerID: "openai",
        code: "ABORT_ERR",
      },
    })

    expect(presentation.kind).toBe("aborted")
    expect(presentation.title).toBe("Task interrupted")
    expect(presentation.description).toContain("Output and files already produced are kept")
    expect(presentation.technicalDetails).toContain("Error type: MessageAbortedError")
    expect(presentation.technicalDetails).toContain("Provider: openai")
    expect(presentation.technicalDetails).toContain("Code: ABORT_ERR")
    expect(presentation.recoveryPrompt).toContain("do not repeat side effects")
  })

  test("distinguishes a provider header timeout from an engine abort", () => {
    const presentation = presentOpencodeSessionError({
      name: "ProviderHeaderTimeoutError",
      data: {
        message: "Provider response headers timed out after 10000ms",
        providerID: "openai",
        retries: 2,
      },
    })

    expect(presentation.kind).toBe("provider-timeout")
    expect(presentation.title).toBe("Provider did not respond in time")
    expect(presentation.technicalDetails).toContain("Retries: 2")
    expect(presentation.recoveryPrompt).not.toBeNull()
  })

  test("stores structured error data on the synthetic message for reload-safe rendering", () => {
    const presentation = presentOpencodeSessionError({
      name: "MessageAbortedError",
      data: { message: "Aborted" },
    })
    const message = createSessionErrorUIMessage("assistant-turn", presentation)

    expect(sessionErrorPresentationFromUIMessage(message)).toEqual(presentation)
  })

  test("keeps partial output and adds the recoverable error beside the failed turn", () => {
    const syncInput = {
      workspaceId: "workspace-1",
      baseUrl: "http://127.0.0.1:1234",
      openworkToken: "token",
    }
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput)
    const release = trackWorkspaceSessionSync(syncInput, "session-1")
    const partialMessage: UIMessage = {
      id: "assistant-turn",
      role: "assistant",
      parts: [{ type: "text", text: "I finished the first step.", state: "done" }],
    }
    getReactQueryClient().setQueryData(
      transcriptKey("workspace-1", "session-1"),
      [partialMessage],
    )

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "session.error",
        properties: {
          sessionID: "session-1",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      })

      const transcript = getReactQueryClient().getQueryData<UIMessage[]>(
        transcriptKey("workspace-1", "session-1"),
      )
      expect(transcript?.[0]).toEqual(partialMessage)
      expect(transcript?.[1]?.id).toBe("session-error:assistant-turn")
      const errorMessage = transcript?.[1]
      if (!errorMessage) throw new Error("Expected the session error message")
      expect(sessionErrorPresentationFromUIMessage(errorMessage)).toMatchObject({
        kind: "aborted",
        title: "Task interrupted",
      })
    } finally {
      release()
      cleanup()
    }
  })

  test("renders interrupted sessions without the intrusive recovery panel", () => {
    const message = createSessionErrorUIMessage(
      "assistant-turn",
      presentOpencodeSessionError({
        name: "MessageAbortedError",
        data: { message: "Aborted" },
      }),
    )
    const html = renderToStaticMarkup(
      <MessageListProvider
        workspaceId="workspace-1"
        sessionId="session-1"
        showThinking={false}
        developerMode={false}
        displaySuggestions={false}
        providerConnectedCount={1}
        dispatchAction={() => undefined}
        setPrompt={() => undefined}
        onRevertToUserMessage={() => undefined}
        onForkAtMessage={() => undefined}
        onEditUserMessage={() => undefined}
        onMcpReconnect={async () => "connected"}
        onMcpReopenAuthorization={async () => undefined}
      >
        <MessageList messages={[message]} status="ready" />
      </MessageListProvider>,
    )

    expect(html).toContain("Task interrupted")
    expect(html).not.toContain("Output and files already produced are kept")
    expect(html).not.toContain("Prepare recovery")
    expect(html).not.toContain('aria-label="Show error details"')
    expect(html).not.toContain('data-testid="session-error-details-trigger"')
  })

  const renderErrorTranscriptWithResume = (error: unknown, trailing: UIMessage[] = []) => {
    const message = createSessionErrorUIMessage(
      "assistant-turn",
      presentOpencodeSessionError(error),
    )
    return renderToStaticMarkup(
      <MessageListProvider
        workspaceId="workspace-1"
        sessionId="session-1"
        showThinking={false}
        developerMode={false}
        displaySuggestions={false}
        providerConnectedCount={1}
        dispatchAction={() => undefined}
        setPrompt={() => undefined}
        onRevertToUserMessage={() => undefined}
        onForkAtMessage={() => undefined}
        onEditUserMessage={() => undefined}
        onResumeInterrupted={() => undefined}
        onMcpReconnect={async () => "connected"}
        onMcpReopenAuthorization={async () => undefined}
      >
        <MessageList messages={[message, ...trailing]} status="ready" />
      </MessageListProvider>,
    )
  }

  test.each([
    { message: "API key expired", title: "Your API key has expired", description: "Replace your API key in model settings." },
    { responseBody: '{"error":{"message":"API key expired"}}', title: "Your API key has expired", description: "Replace your API key in model settings." },
    { responseBody: '{"error_description":"API key expired"}', title: "Your API key has expired", description: "Replace your API key in model settings." },
    { responseBody: '{"error":{"code":"invalid_api_key"}}', title: "Your API key wasn’t accepted", description: "Check or replace your API key in model settings." },
    { message: "Invalid API key", title: "Your API key wasn’t accepted", description: "Check or replace your API key in model settings." },
    { message: "Token refresh failed: 401", title: "Your provider sign-in couldn’t be renewed", description: "Sign in to your provider again in model settings." },
    { responseBody: '{"error":{"error_description":"OAuth token refresh failed"}}', title: "Your provider sign-in couldn’t be renewed", description: "Sign in to your provider again in model settings." },
  ])("uses fixed credential copy for $title", ({ message, responseBody, title, description }) => {
    for (const name of ["APIError", "ProviderAuthError"]) {
      const error = { name, data: { message, responseBody, statusCode: 401, isRetryable: true } }
      const presentation = presentOpencodeSessionError(error)
      expect(presentation).toMatchObject({ kind: "provider-credentials", title, description, recoveryPrompt: null })
      expect(sessionErrorPresentationFromUIMessage(createSessionErrorUIMessage("turn", presentation))).toEqual(presentation)
      const html = renderErrorTranscriptWithResume(error)
      expect(html).toContain(title)
      expect(html).not.toContain('aria-label="Retry task"')
      expect(html).not.toContain('data-testid="session-error-resume"')
      expect(html).toContain('data-testid="session-error-gateway-connect"')
      expect(presentation.connectUrl).toBeUndefined()
      expect(html).not.toContain("Status: 401")
    }
  })

  test.each([
    {},
    { message: "Unauthorized" },
    { message: "OAuth token expired" },
    { message: "invalid_grant" },
    { message: "Unrelated text: API key expired; diagnostic-marker" },
    { responseBody: '{"debug":{"message":"API key expired"}}' },
    { responseBody: '{"error":{"message":"API key expired; diagnostic-marker"}}' },
    { responseBody: "API key expired" },
    { responseBody: '{"error_description":"API key expired"' },
    { responseBody: JSON.stringify({ error_description: "API key expired", padding: "x".repeat(16_384) }) },
  ])("keeps ambiguous or unsupported credential evidence generic: %j", (data) => {
    const error = { name: "APIError", data: { ...data, statusCode: 401 } }
    expect(presentOpencodeSessionError(error)).toMatchObject({
      kind: "provider-credentials", title: "Check your model connection", description: "Update your connection in model settings.", recoveryPrompt: null,
    })
    expect(renderErrorTranscriptWithResume(error)).not.toContain("diagnostic-marker")
  })

  test.each([
    { name: "APIError", data: { statusCode: 401, code: "openwork_auth_required" }, kind: "gateway-auth-required", title: "Sign in to keep using this model" },
    { name: "APIError", data: { statusCode: 403 }, kind: "provider-access-denied", title: "You don’t have access to this model" },
    { name: "APIError", data: { code: "ENOTFOUND" }, kind: "network-unavailable", title: "Can’t reach the model service" },
    { name: "TimeoutError", data: { statusCode: 401 }, kind: "provider-timeout", title: "Provider did not respond in time" },
  ])("preserves $kind precedence over credential copy", ({ name, data, kind, title }) => {
    const result = presentOpencodeSessionError({ name, data: { ...data, message: "API key expired" } })
    expect(result).toMatchObject({ kind, title })
    expect(result.recoveryPrompt === null).toBe(["gateway-auth-required", "provider-access-denied"].includes(kind))
  })

  test.each(["upstream_incomplete", "upstream_interrupted", "upstream_malformed_stream", "upstream_malformed_response", "upstream_timeout"])("renders the %s safety warning with Resume without exposing diagnostics", (code) => {
    const error = {
      name: "APIError",
      data: {
        message: `${code}: Connection closed before completion`,
        statusCode: 200,
        isRetryable: false,
        responseBody: '{"request_id":"managed-interruption-diagnostic"}',
      },
    }
    const presentation = presentOpencodeSessionError(error)
    expect(presentation).toMatchObject({ kind: "provider-incomplete", title: "The model response was interrupted" })
    expect(presentation.recoveryPrompt).toContain("do not repeat side effects")
    const html = renderErrorTranscriptWithResume(error)
    expect(html).toContain('data-testid="session-error-interruption-warning"')
    expect(html).toContain("Some steps may have finished. Check before continuing.")
    expect(html).toContain('data-testid="session-error-resume"')
    expect(html).not.toContain('data-testid="session-error-details-toggle"')
    expect(html).not.toContain(code)
    expect(html).not.toContain("Status: 200")
    expect(html).not.toContain("managed-interruption-diagnostic")
  })
  test("classifies openwork_auth_required but never trusts an upstream auth_url as a Connect target", () => {
    const authUrl = "https://evil.example.test/steal-session"
    const body = JSON.stringify({
      error: { code: "openwork_auth_required", message: "Sign in to Member Vertex to continue.", auth_url: authUrl, provider_id: "ipr_member" },
    })
    const presentation = presentOpencodeSessionError({
      name: "APIError",
      data: { message: `Unauthorized: ${body}`, statusCode: 401, providerID: "ipr_member", responseBody: body },
    })

    expect(presentation.kind).toBe("gateway-auth-required")
    expect(presentation.title).toBe("Sign in to keep using this model")
    expect(presentation.description).toBe("Sign in to Member Vertex to continue.")
    expect(presentation.connectUrl).toBeNull()
    expect(presentation.recoveryPrompt).toBeNull()

    const html = renderErrorTranscriptWithResume({
      name: "APIError",
      data: { message: `Unauthorized: ${body}`, statusCode: 401, responseBody: body },
    })
    expect(html).toContain('data-testid="session-error-gateway-connect"')
    expect(html).toContain("Connect")
    expect(html).not.toContain('data-testid="session-error-resume"')
  })

  test("still offers Connect (deep-linking to providers) when the auth body has no auth_url", () => {
    const presentation = presentOpencodeSessionError({
      name: "APIError",
      data: { message: '{"error":{"code":"openwork_auth_required","provider_id":"ipr_member"}}', statusCode: 401 },
    })
    expect(presentation.kind).toBe("gateway-auth-required")
    expect(presentation.connectUrl).toBeNull()
    expect(presentation.description).toContain("Connect it again")
    expect(
      sessionErrorPresentationFromUIMessage(createSessionErrorUIMessage("turn", presentation)),
    ).toEqual(presentation)
  })

  test("does not classify an ordinary 401 as a gateway sign-in", () => {
    const presentation = presentOpencodeSessionError({
      name: "APIError",
      data: { message: "invalid_api_key", statusCode: 401 },
    })
    expect(presentation.kind).toBe("provider-credentials")
    expect(presentation.connectUrl).toBeUndefined()
  })

  test("offers an accessible icon-only retry below an interrupted message", () => {
    const html = renderErrorTranscriptWithResume({
      name: "MessageAbortedError",
      data: { message: "Aborted" },
    })

    expect(html).toContain('data-testid="session-error-resume"')
    expect(html).toContain('aria-label="Retry task"')
    expect(html).not.toContain(">Resume<")
  })

  test("historical interruptions do not offer a retry for an already superseded task", () => {
    const html = renderErrorTranscriptWithResume({ name: "MessageAbortedError", data: { message: "Aborted" } }, [
      { id: "later-answer", role: "assistant", parts: [{ type: "text", text: "The next task is complete." }] },
    ])
    expect(html).toContain("Task interrupted")
    expect(html).not.toContain('aria-label="Retry task"')
  })

  test("explains local workspace and model access errors without exposing machine details", () => {
    const local = presentOpencodeSessionError(new Error("Error invoking remote method 'openwork:desktop': TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:12345"))
    expect(local.title).toBe("Can’t reach this workspace")
    expect(local.technicalDetails).toContain("ECONNREFUSED")
    expect(local.recoveryPrompt).toBeNull()
    const denied = { name: "APIError", data: { message: "Forbidden", statusCode: 403 } }
    expect(presentOpencodeSessionError(denied).title).toBe("You don’t have access to this model")
    const html = renderErrorTranscriptWithResume(denied)
    expect(html).toContain("Change model")
    expect(html).not.toContain('aria-label="Retry task"')
    expect(html).not.toContain("Forbidden")
    expect(presentOpencodeSessionError("connect ECONNREFUSED 127.0.0.1:12345").kind).toBe("generic")
  })

  test("renders a resumable interruption as a quiet status line, not an error card", () => {
    const html = renderErrorTranscriptWithResume({
      name: "MessageAbortedError",
      data: { message: "Aborted" },
    })

    expect(html).toContain("Task interrupted")
    expect(html).toContain('data-testid="session-error-interrupted"')
    expect(html).not.toContain('data-testid="session-error-interruption-warning"')
    expect(html).not.toContain("Output and files already produced are kept")
    expect(html).not.toContain("border-destructive/30")
    expect(html).not.toContain("bg-destructive/5")
  })

  test("keeps a failure alert for errors that cannot be resumed", () => {
    const html = renderErrorTranscriptWithResume({
      name: "ProviderAuthError",
      data: { message: "Provider authentication failed" },
    })

    expect(html).toContain('role="alert"')
    expect(html).toContain("Check your model connection")
  })

  test("offers Resume on the error card for a provider timeout", () => {
    const html = renderErrorTranscriptWithResume({
      name: "ProviderHeaderTimeoutError",
      data: { message: "Provider response headers timed out after 10000ms" },
    })

    expect(html).toContain('data-testid="session-error-resume"')
  })

  test("hides Resume for errors that cannot be resumed", () => {
    const html = renderErrorTranscriptWithResume({
      name: "ProviderAuthError",
      data: { message: "Provider authentication failed" },
    })

    expect(html).not.toContain('data-testid="session-error-resume"')
    expect(html).not.toContain(">Resume<")
  })

  test("renders the free starter model limit without provider details or Resume", () => {
    const html = renderErrorTranscriptWithResume(freeTierFailure)

    expect(html).toContain("The free starter model is busy right now")
    expect(html).toContain("connect your own model provider")
    expect(html).not.toContain("Error from provider")
    expect(html).not.toContain('data-testid="session-error-resume"')
    expect(html).not.toContain(">Resume<")
  })

  test("renders provider setup for free-tier retries without changing other retry actions", async () => {
    const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined"
    if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" })
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      value: true,
    })
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    const dispatchAction = mock(() => undefined)
    type RetryStatus = Extract<SessionStatus, { type: "retry" }>
    const renderRetry = async (retryStatus: RetryStatus) => {
      await act(async () => {
        root.render(
          <MessageListProvider
            workspaceId="workspace-1"
            sessionId="session-1"
            showThinking={false}
            developerMode={false}
            displaySuggestions={false}
            providerConnectedCount={1}
            dispatchAction={dispatchAction}
            setPrompt={() => undefined}
            onRevertToUserMessage={() => undefined}
            onForkAtMessage={() => undefined}
            onEditUserMessage={() => undefined}
            onMcpReconnect={async () => "connected"}
            onMcpReopenAuthorization={async () => undefined}
          >
            <MessageList
              messages={[{
                id: "assistant-turn",
                role: "assistant",
                parts: [{ type: "text", text: "Existing response" }],
              }]}
              status="retrying"
              retryStatus={retryStatus}
            />
          </MessageListProvider>,
        )
      })
    }

    try {
      await renderRetry({
        type: "retry",
        attempt: 2,
        next: Date.now() + 8000,
        message: "Free usage exceeded, subscribe to Go",
        action: {
          reason: "free_tier_limit",
          provider: "opencode",
          title: "Free limit reached",
          message: "Subscribe to OpenCode Go for reliable access to the best open-source models, starting at $5/month.",
          label: "subscribe",
          link: "https://opencode.ai/go",
        },
      })

      expect(container.textContent).toContain("The free starter model is busy right now")
      expect(container.textContent).toContain("Connect a model provider")
      expect(container.textContent).not.toContain("subscribe to Go")
      expect(container.textContent).not.toContain("OpenCode Go")
      expect(container.textContent).not.toContain("$5/month")
      const connectButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Connect a model provider",
      )
      if (!connectButton) throw new Error("Expected the Connect a model provider button")
      await act(async () => connectButton.click())
      expect(dispatchAction).toHaveBeenCalledWith({
        target: "settings",
        action: "open",
        section: "providers",
      })

      await renderRetry({
        type: "retry",
        attempt: 2,
        next: Date.now() + 8000,
        message: "Account rate limited",
        action: {
          reason: "account_rate_limit",
          provider: "opencode",
          title: "Account rate limit reached",
          message: "Review your account limits.",
          label: "Review account",
          link: "https://opencode.ai/account",
        },
      })

      expect(container.textContent).toContain("Account rate limit reached")
      expect(container.textContent).toContain("Review account")

      await renderRetry({ type: "retry", attempt: 4, next: Date.now() + 11000, message: "Internal server error" })
      expect(container.querySelector('[role="status"]')?.textContent).toBe("The model couldn’t respond. Retrying…")
      expect(container.textContent).not.toContain("Internal server error")
      expect(container.textContent).not.toContain("attempt 4")
      const details = container.querySelector<HTMLButtonElement>('[data-testid="session-error-details-toggle"]')
      if (!details) throw new Error("Missing retry details")
      expect(details.textContent).toBe("")
      expect(details.getAttribute("aria-label")).toBe("Technical details")
      expect(container.querySelector('[data-testid="session-retrying"] .lucide-triangle-alert')).toBeNull()
      expect(container.querySelector('[data-testid="session-retrying"] .animate-spin')).toBeNull()
      await act(async () => details.click())
      expect(container.querySelector('[data-testid="session-error-details"]')?.textContent).toContain("attempt 4")
      expect(container.querySelector('[role="status"]')?.textContent).not.toContain("attempt")
    } finally {
      await act(async () => root.unmount())
      container.remove()
      if (registeredDom) GlobalRegistrator.unregister()
    }
  })
})

describe("session error technical details", () => {
  const providerFailure = {
    name: "APIError",
    data: {
      message: "Rate limit reached for claude-sonnet-4-5 on requests per minute (RPM).",
      statusCode: 429,
      providerID: "anthropic",
      code: "rate_limit_error",
      retries: 3,
      responseBody: JSON.stringify({ type: "error", request_id: "req_01JZK4W9N7X2Q8M3V5T6B1C0DE" }),
    },
  }

  const renderErrorTranscript = (error: unknown, developerMode: boolean, messages?: UIMessage[]) => {
    const message = createSessionErrorUIMessage("assistant-turn", presentOpencodeSessionError(error))
    return renderToStaticMarkup(
      <PlatformProvider value={createDefaultPlatform()}><MessageListProvider
        workspaceId="workspace-1"
        sessionId="session-1"
        showThinking={false}
        developerMode={developerMode}
        displaySuggestions={false}
        providerConnectedCount={1}
        dispatchAction={() => undefined}
        setPrompt={() => undefined}
        onRevertToUserMessage={() => undefined}
        onForkAtMessage={() => undefined}
        onEditUserMessage={() => undefined}
        onMcpReconnect={async () => "connected"}
        onMcpReopenAuthorization={async () => undefined}
      >
        <MessageList messages={messages ?? [message]} status="ready" />
      </MessageListProvider></PlatformProvider>,
    )
  }

  test("Auto rejection stays beside a dimmed unprocessed message with free sign-in and switch actions", async () => {
    const auth = await import("../src/react-app/domains/cloud/den-auth-provider")
    const spy = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_out", user: null, verifiedIdentity: null, isSignedIn: false, error: null, refresh: async () => undefined })
    try {
      const html = renderErrorTranscript(null, false, [{ id: "not-sent", role: "user", metadata: { autoAccessWall: { state: "limit" }, unprocessed: true }, parts: [{ type: "text", text: "Unprocessed request" }] }])
      expect(html).toContain('data-unprocessed="true"')
      expect(html).toContain("opacity-50")
      expect(html).toContain("This week’s free limit is used up")
      expect(html).toContain("Sign in to OpenWork")
      expect(html).toContain("Switch model")
      expect(html).not.toMatch(/Upgrade|USD|View plans|automatically retry/)
      expect(renderErrorTranscript({ code: "anonymous_limit_exceeded" }, false)).toContain('data-testid="auto-access-wall"')
    } finally { spy.mockRestore() }
  })

  test("end users see only the plain error card", () => {
    const html = renderErrorTranscript(providerFailure, false)

    expect(html).toContain("This model is receiving too many requests")
    expect(html).not.toContain('data-testid="session-error-details-toggle"')
    expect(html).not.toContain("Status: 429")
    expect(html).not.toContain("req_01JZK4W9N7X2Q8M3V5T6B1C0DE")
  })

  test("developer mode adds a collapsed Technical details disclosure holding the full diagnostic payload", () => {
    const html = renderErrorTranscript(providerFailure, true)

    expect(html).toContain('data-testid="session-error-details-toggle"')
    expect(html).toContain('aria-expanded="false"')
    // Collapsed by default: the payload is not in the DOM until opened.
    expect(html).not.toContain('data-testid="session-error-details"')
    expect(html).not.toContain("Status: 429")
  })

  test("keeps managed interruption guidance visible when Resume is unavailable", () => {
    const html = renderErrorTranscript({
      name: "APIError",
      data: { message: "upstream_incomplete: Connection closed before completion" },
    }, false)
    expect(html).toContain("Some steps may have finished. Check before continuing.")
    expect(html).not.toContain('data-testid="session-error-resume"')
    expect(html).not.toContain('data-testid="session-error-details-toggle"')
    expect(html).not.toContain("upstream_incomplete")
  })

  test("storage errors show guidance without technical codes outside developer mode", () => {
    const raw = "effect/sql/SqlError: Failed to execute statement\n at runLoop (/$bunfs/root/chunk.js:25:2045)\nENOSPC: no space left on device"
    const html = renderErrorTranscript(raw, false)
    expect(html).toContain("Storage error reported")
    expect(html).toContain("does not necessarily mean your computer is full")
    expect(html).not.toContain("SqlError")
    expect(html).not.toContain("runLoop")
    expect(html).not.toContain("ENOSPC")
    expect(html).not.toContain('data-testid="session-error-details-toggle"')
    expect(renderErrorTranscript(raw, true)).toContain('data-testid="session-error-details-toggle"')
  })

  test("a bare error whose details only repeat the message gets no disclosure even in developer mode", () => {
    const html = renderErrorTranscript("Session failed", true)

    expect(html).toContain("Session failed")
    expect(html).not.toContain('data-testid="session-error-details-toggle"')
  })
})

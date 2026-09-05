import { afterEach, describe, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { UIMessage } from "ai"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"

import { MessageList } from "../src/components/chat/message-list"
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

describe("session error resilience", () => {
  test("managed stream failures offer explicit recovery and retain the interruption category", () => {
    const presentation = presentOpencodeSessionError({ name: "APIError", data: { message: "upstream_incomplete: Connection closed before completion", statusCode: 200, isRetryable: false } });
    expect(presentation).toMatchObject({ kind: "provider-incomplete", title: "The model response was interrupted" });
    expect(presentation.description).toContain("Review them before continuing");
  });
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
    expect(presentation.title).toBe("Not enough disk space")
    expect(presentation.description).toContain("Free up some disk space")
    expect(presentation.description).toContain("cloud workspace")
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
        onMcpRetry={() => undefined}
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

  const renderErrorTranscriptWithResume = (error: unknown) => {
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
        onMcpRetry={() => undefined}
      >
        <MessageList messages={[message]} status="ready" />
      </MessageListProvider>,
    )
  }

  test("offers Resume on the error card for an engine abort", () => {
    const html = renderErrorTranscriptWithResume({
      name: "MessageAbortedError",
      data: { message: "Aborted" },
    })

    expect(html).toContain('data-testid="session-error-resume"')
    expect(html).toContain("Resume")
  })

  test("renders a resumable interruption as a quiet status line, not an error card", () => {
    const html = renderErrorTranscriptWithResume({
      name: "MessageAbortedError",
      data: { message: "Aborted" },
    })

    expect(html).toContain("Task interrupted")
    expect(html).toContain('data-testid="session-error-interrupted"')
    expect(html).not.toContain("border-destructive/30")
    expect(html).not.toContain("bg-destructive/5")
  })

  test("keeps the destructive card for errors that cannot be resumed", () => {
    const html = renderErrorTranscriptWithResume({
      name: "ProviderAuthError",
      data: { message: "Provider authentication failed" },
    })

    expect(html).toContain("border-destructive/30")
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
            onMcpRetry={() => undefined}
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

  const renderErrorTranscript = (error: unknown, developerMode: boolean) => {
    const message = createSessionErrorUIMessage("assistant-turn", presentOpencodeSessionError(error))
    return renderToStaticMarkup(
      <MessageListProvider
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
        onMcpRetry={() => undefined}
      >
        <MessageList messages={[message]} status="ready" />
      </MessageListProvider>,
    )
  }

  test("end users see only the plain error card", () => {
    const html = renderErrorTranscript(providerFailure, false)

    expect(html).toContain("Rate limit reached")
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

  test("storage errors show guidance without technical codes outside developer mode", () => {
    const raw = "effect/sql/SqlError: Failed to execute statement\n at runLoop (/$bunfs/root/chunk.js:25:2045)\nENOSPC: no space left on device"
    const html = renderErrorTranscript(raw, false)
    expect(html).toContain("Not enough disk space")
    expect(html).toContain("Free up some disk space")
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

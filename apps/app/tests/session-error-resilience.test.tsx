import { afterEach, describe, expect, test } from "bun:test"
import type { UIMessage } from "ai"
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

  test("a bare error whose details only repeat the message gets no disclosure even in developer mode", () => {
    const html = renderErrorTranscript("Session failed", true)

    expect(html).toContain("Session failed")
    expect(html).not.toContain('data-testid="session-error-details-toggle"')
  })
})

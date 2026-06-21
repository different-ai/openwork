/**
 * Voice Mode includes recent current-session transcript context when minting
 * the OpenAI Realtime session.
 */
const USER_CONTEXT = "We last discussed the Falcon launch checklist and agreed that this means the telemetry retry plan.";
const ASSISTANT_CONTEXT = "Next step: update the Falcon telemetry retry plan before launch review.";

const seededMessages = [
  {
    id: "msg-user-falcon-context",
    info: { role: "user" },
    parts: [{ type: "text", text: USER_CONTEXT }],
  },
  {
    id: "msg-assistant-falcon-context",
    info: { role: "assistant" },
    parts: [{ type: "text", text: ASSISTANT_CONTEXT }],
  },
];

export default {
  id: "voice-session-context",
  title: "Voice Mode request includes recent session context",
  spec: "evals/react-session-flows.md",
  precondition: async (ctx) => {
    await ctx.waitFor("Boolean(window.__openworkControl)", {
      timeoutMs: 60_000,
      label: "control API",
    });
    const state = await ctx.waitFor(
      `(() => {
        const control = window.__openworkControl;
        if (control.snapshot().route.startsWith("/welcome")) return "welcome";
        const hasVoiceOpen = control.listActions().some((action) => action.id === "voice.panel.open" && !action.disabled);
        return hasVoiceOpen ? "ready" : null;
      })()`,
      { timeoutMs: 30_000, label: "session route with Voice Mode action" },
    );
    return state === "welcome"
      ? "Profile is not onboarded (welcome screen, no workspace/session for Voice Mode)."
      : null;
  },
  steps: [
    {
      name: "Install fetch interceptor for transcript and realtime session requests",
      run: async (ctx) => {
        await ctx.eval(`(() => {
          window.__voiceSessionContextEval = {
            capturedVoiceRequest: null,
            capturedMessagesRequest: null,
            userContext: ${JSON.stringify(USER_CONTEXT)},
            assistantContext: ${JSON.stringify(ASSISTANT_CONTEXT)},
          };
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            const method = (init && init.method ? init.method : "GET").toUpperCase();
            if (url.includes("/sessions/") && url.includes("/messages")) {
              window.__voiceSessionContextEval.capturedMessagesRequest = { url, method };
              return new Response(JSON.stringify({ items: ${JSON.stringify(seededMessages)} }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            if (url.endsWith("/voice/realtime/session")) {
              const body = typeof init?.body === "string" ? init.body : "";
              window.__voiceSessionContextEval.capturedVoiceRequest = { url, method, body };
              return new Response(JSON.stringify({
                ok: true,
                clientSecret: "eval-client-secret",
                expiresAt: null,
                model: "gpt-realtime-eval",
                transcriptionModel: "gpt-4o-mini-transcribe",
                tools: [],
              }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            return originalFetch(input, init);
          };
          return true;
        })()`);
      },
    },
    {
      name: "Open Voice Mode panel",
      run: async (ctx) => {
        await ctx.control("voice.panel.open");
        await ctx.waitForText("Voice Mode", { timeoutMs: 15_000 });
        await ctx.waitFor(
          "window.__openworkControl.listActions().some((action) => action.id === 'voice.start' && !action.disabled)",
          { timeoutMs: 15_000, label: "voice.start action enabled" },
        );
      },
    },
    {
      name: "Start Voice Mode and capture request body",
      run: async (ctx) => {
        await ctx.eval(`window.__openworkControl.execute("voice.start").catch((error) => ({ ok: false, error: String(error?.message || error) }))`, {
          awaitPromise: false,
        });
        const captured = await ctx.waitFor(
          "window.__voiceSessionContextEval && window.__voiceSessionContextEval.capturedVoiceRequest",
          { timeoutMs: 20_000, label: "captured /voice/realtime/session request" },
        );
        ctx.log(`captured voice request: ${JSON.stringify(captured)}`);
      },
    },
    {
      name: "Assert request includes enough recent context for 'what did we last discuss?' and 'this'",
      run: async (ctx) => {
        const payload = await ctx.eval(`(() => {
          const request = window.__voiceSessionContextEval?.capturedVoiceRequest;
          return request?.body ? JSON.parse(request.body) : null;
        })()`);
        ctx.assert(payload && typeof payload.sessionContext === "string", "Voice realtime request did not include sessionContext.");
        ctx.assert(payload.sessionContext.includes("User: "), "sessionContext did not include a user transcript entry.");
        ctx.assert(payload.sessionContext.includes("Assistant: "), "sessionContext did not include an assistant transcript entry.");
        ctx.assert(payload.sessionContext.includes(USER_CONTEXT), "sessionContext missed the recent user discussion context.");
        ctx.assert(payload.sessionContext.includes(ASSISTANT_CONTEXT), "sessionContext missed the recent assistant next-step context.");
        ctx.assert(payload.sessionContext.includes("this means the telemetry retry plan"), "sessionContext was not sufficient to resolve 'this'.");
        ctx.assert(payload.sessionContext.length < 6_000, "sessionContext exceeded the expected request budget.");
        ctx.log(`sessionContext: ${payload.sessionContext}`);
        await ctx.screenshot("voice-context-captured");
      },
    },
  ],
};

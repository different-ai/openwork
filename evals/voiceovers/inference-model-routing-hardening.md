# inference-model-routing-hardening — Only approved model selections reach OpenRouter

1. An authenticated client sends `POST /api/v1/chat/completions` with an enabled OpenWork model, and it is rewritten and forwarded normally.

2. Requests containing `models`, `fallbacks`, `preset`, or `route` are rejected before reaching OpenRouter.

3. OpenRouter tools/plugins that can select nested models—Fusion, advisor, subagent, and image generation—are rejected, while ordinary function tools remain supported.

4. Only approved inference routes and methods are accepted; `GET /api/v1/models` returns the local enabled catalog instead of OpenRouter’s full catalog.

5. Regression tests prove no alternate model selector or unsupported route reaches OpenRouter.

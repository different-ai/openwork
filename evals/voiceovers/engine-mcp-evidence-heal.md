# engine-mcp-evidence-heal — Diagnostics follow live engine reality

This internal proof follows one isolated repro run from the forced slow first handshake through healed live engine health and the final diagnostics verdict.

1. On an isolated Daytona sandbox, we recreate the customer's trap against a real OpenWork server, real engine, and real Den: the very first cloud connection attempt is forced to outlast the registration window, so the system records a failure — exactly what a slow first handshake does in the field.

2. Reality heals itself: without anyone opening a chat or repairing anything, the engine finishes connecting on its own and live health shows the cloud connection working.

3. And now the diagnostics tell the truth: the same report that used to cry "registration not connected" on a healthy system shows the managed connection as connected, with fresh evidence that the engine is reachable — the "open a chat so it works" ritual is gone.

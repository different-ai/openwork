# Follow the computer's proxy settings (`desktopSystemProxy`)

- **Feature key:** `desktopSystemProxy`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @benjaminshafii

## What people get

On a network that only lets traffic out through a company proxy, the agent
works without anyone setting anything up on the computer. Connectors, the
person's own model providers, web fetches and the commands the agent runs use
the same route as the OpenWork window: the proxy the computer is set to,
including automatic (PAC) and auto-detected settings, decided per address.

Without the feature, only the window follows those settings. The agent engine
connects directly unless OpenWork was started with `HTTP_PROXY` /
`HTTPS_PROXY` set, so on a proxy-only network connectors time out and
own-key providers cannot be reached.

## How it works

- The desktop app runs a small forward proxy on `127.0.0.1` (a random port,
  protected by a per-launch token). For each connection it asks Chromium how
  the system settings route that address and then connects directly, or
  through the HTTP, HTTPS or SOCKS5 proxy it names, trying the listed proxies
  in order.
- The agent engine is started with `HTTP_PROXY` / `HTTPS_PROXY` (both
  spellings) pointing at that local proxy and with loopback in `NO_PROXY`.
  The commands and connectors the engine starts inherit them.
- A proxy address the person or their IT already put in the environment
  wins: the engine keeps using it and the local proxy is not used.
- An engine reads its proxy once, when it starts, and the organization is
  only known after sign-in. So the last checked answer is remembered on the
  computer (`engine-system-proxy.json` next to `runtime.sqlite`) and used for
  the next start. When a fresh check differs from what the running engine
  was started with, an idle engine is replaced right away; a busy one keeps
  working and picks the change up the next time it starts.
- The answer is checked when the window delivers a sign-in or sign-out, and
  once shortly after launch for someone who is signed out (the deployment's
  default). A check that cannot be read changes nothing.
- If the local proxy cannot start, or the system settings cannot be read in
  ten seconds, connections go direct, as they do without the feature.

## Limits

- A company proxy that asks for a username and password is not signed in to;
  its refusal is passed back to the caller.
- SOCKS4 proxies are skipped.
- Requests the desktop app's own background services make outside the engine
  are not covered.

## Turning it off

The kill switch takes effect at the next check: an idle engine is restarted
without the proxy variables, a busy one at its next start. Nothing is stored
on the server.

## What to watch

- Desktop logs: `[system-proxy] routing through: …` shows the kinds of route
  in use, `[system-proxy] could not reach …` a proxy or site that refused.
- Engine start failures (`engine.v2.start`) right after enabling it for an
  organization.

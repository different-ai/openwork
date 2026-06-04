# Extension Manifest Foundation

OpenWork should expose `extension` as the user-facing abstraction. Claude/Anthropic plugins are an initial source format that Den adapts into OpenWork extensions, not a separate product concept.

## Shape

An extension is a manifest-backed installed capability:

- `source`: where it came from, such as built-in, Den Claude plugin import, OpenWork manifest, MCP directory, or manual local install.
- `resources`: installable primitives, such as skills, MCP servers, OpenCode plugins, providers, secrets, native binaries, hooks, commands, or context files.
- `setup`: custom instructions, required env vars, primary CTA text, and optional test action refs.
- `contributions`: allowlisted UI/runtime refs, such as settings panels, composer prompts, session side panels, rail items, server routes, control actions, native capabilities, and tests.
- `lifecycle`: reload/detection hints for OpenCode config, plugins, skills, MCP, agents, or commands.

## PR Stack

1. Foundation PR: typed manifest model, manifest-backed built-in catalog, generic setup/resource/contribution display, Den copy shifted to extensions.
2. Handsfree PR: add a trusted built-in extension manifest with native-binary, local MCP, macOS permission, health-check, and setup/test contributions.
3. Voice Mode PR: add a trusted built-in extension manifest with settings, side panel, rail item, server route, Realtime secret, control-action, and test contributions.
4. Den follow-up: expose extension projections from existing plugin rows while initially supporting Claude-compatible plugin repos as the only external source adapter.

## Electron CDP Flows

Always launch these from the Electron sandbox, not a standalone browser:

- Extensions catalog opens and shows built-ins from manifests.
- Built-in policy disables only trusted built-in extensions, not Den marketplace extensions.
- Marketplace imports appear as installed extensions with resource composition.
- Image Gen setup accepts `OPENAI_API_KEY`, writes plugin/config files, and can run the test action.
- Ollama setup detects local availability, lists/pulls models, patches provider config, and reloads.
- Handsfree setup shows macOS permission/health status, resolves the Electron-local MCP command, installs MCP config, and verifies a tool call.
- Voice setup saves/uses an OpenAI key, mints a Realtime client secret through the local server, opens the right-side panel, and executes a semantic OpenWork UI action.

Den/local endpoint testing should point Electron at the target Den base URL through the existing Cloud account settings or the desktop bootstrap env/config path. OpenAI-key flows should use the OpenWork env store, preferring short-lived renderer credentials for Realtime.

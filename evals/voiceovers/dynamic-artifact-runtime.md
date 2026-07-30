# Dynamic artifact runtime — describe, build, interact, and reuse

This demo uses the deterministic Launch Radar project so every frame proves the product without a model, provider, network service, or Den.

1. "I enable the managed Artifact Builder skill for this workspace. The injected instructions teach agents the bounded project workflow, while this library lets me create, list, enable, disable, and reopen every generated artifact."

2. "I describe the launch radar I need. In a real task, the agent works in code mode, can delegate the bounded React implementation to a subagent, reviews the project, and attaches its immutable build directly in chat."

3. "The result is real React, but it does not inherit OpenWork's authority. Suspense and an error boundary protect the conversation while an opaque iframe denies network access, host DOM access, credentials, and arbitrary tools."

4. "I can still use it like a small app. Clicking Watch launch updates only this artifact's bounded local state, and OpenWork persists a new state revision outside the isolated frame."

5. "Open editor takes me from the chat attachment to the artifact workspace. Library and Editor keep the reusable project together with its manifest, React source, styles, data, and JSON Schema contract."

6. "I can inspect or enhance the source and data contract while a live preview stays beside the editor. The visible revision identifies the exact immutable build attached to this conversation."

7. "After a reload, the same pinned build and watched-launch state return. I reopen Launch Radar from the Artifacts library, ready to reuse as-is or evolve into a new revision later."

8. "The library also manages the lifecycle. I disable Launch Radar, which blocks new builds while preserving its source, editor, immutable revision, and pinned preview. Workspace-level agent authoring has its own explicit Artifact Builder skill switch."

9. "The experience is not agent-only. Create artifact gives me the same bounded starting point, asks for a human-readable name and purpose, and shows the durable workspace slug before I create anything."

10. "The workspace skill and each project have independent controls. I can restore injected agent authoring and re-enable Launch Radar for new builds without affecting any already-pinned conversation artifact."

11. "Inside the artifact, Ask agent about launch risk crosses a deliberately narrow bridge. It stages the declared launch.explain intent in my composer, including its effect and confirmation contract, but does not send it or execute a tool."

12. "artifact.json makes the runtime contract inspectable: protocol and API versions, React entrypoint, data and schema paths, chat and tab presentation, plus every declared intent, argument, effect, and confirmation policy."

13. "src/App.tsx is ordinary typed JSX. Data and state arrive as props, while the injected runtime exposes only replaceState and invoke—enough for a rich app without granting browser, filesystem, credential, or tool authority."

14. "styles.css is its own expressive layer. The agent or user can evolve layout, motion, color, and component states without mixing presentation into the manifest, data, or React contract."

15. "data.json keeps the current artifact values portable and understandable. A later enhancement can update the mission data without reconstructing the component or weakening its schema boundary."

16. "data.schema.json is the build-time contract for those values. Required fields, types, bounds, and additional-property rules are validated before a generated component can become a pinned build."

17. "Now I try an unsafe source change with an unbounded loop. The compiler refuses to publish it, keeps src/App.tsx selected with a structured line-and-column diagnostic, and preserves the last known-good isolated preview."

18. "I restore the safe component, raise Apollo readiness in data.json, and rebuild. OpenWork produces a new immutable revision and a visible compiler receipt instead of mutating the original artifact in place."

19. "Back in chat, the existing Launch Radar card remains pinned to the exact revision and interaction state it started with. Project evolution never silently rewrites the history of a conversation."

20. "I disable the enhanced project. New publication is blocked, but its source, new revision, editor, and last known-good preview remain available so governance does not become accidental data loss."

21. "I also disable the workspace Artifact Builder skill. The injected instructions disappear from future agent context, while Launch Radar stays listed and existing pinned artifacts continue to render and interact."

22. "Generated React projects coexist with OpenWork's standard native answer artifacts as separate catalogs. Workspace brief, calendars, widgets, communication, inbox, attention, and approval cards keep their own validated lifecycle."

23. "The master UI artifacts switch also works without a cloud account. Signed-out workspaces save the choice on this device and restore it after reload, while signed-in workspaces keep the same control synchronized to their active organization."

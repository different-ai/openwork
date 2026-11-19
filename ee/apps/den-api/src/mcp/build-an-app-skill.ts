import { appStarterResourceUri } from "./app-authoring-starter.js"
import type { CodemodeLanguage } from "./codemode-script-object.js"

export const BUILTIN_BUILD_AN_APP_CAPABILITY = "skill:build-an-app"

/**
 * Which forms run one item at a time. OpenWork's dialect awaits an async
 * callback in forEach, filter or reduce; standard JavaScript never does. The
 * language rules themselves are stated once, in execute_capability_script's
 * description (workflowCodeRules).
 */
const SERIAL_FORMS: Record<CodemodeLanguage, string> = {
  "codemode-js": "A for...of loop that awaits each item, or an async forEach, filter, or reduce callback, runs one item at a time.",
  ecmascript: "A for...of loop that awaits each item runs one item at a time, and forEach, filter, and reduce never await an async callback, so pass async callbacks only to map.",
}

/**
 * The one place agents learn how OpenWork builds artifacts: when to build one, the
 * order of calls, source and tool-call rules, and what a good artifact looks like.
 * Server instructions and the concise builder tool descriptions route here
 * for the detailed rules the compiler and host enforce. Only the Workflow code
 * forms depend on the organization's Workflow language.
 */
export function buildAnAppSkillSource(language: CodemodeLanguage): string {
  return `---
name: build-an-app
description: |
  Build or change an artifact: a small interactive view, such as a dashboard, tracker, lookup, form, or calculator, that opens beside the chat and in any MCP Apps host.

  Triggers when the user asks to:
  - build, make, or create an artifact, live artifact, app, dashboard, tracker, calculator, form, or interactive view
  - turn connected data or a Workflow into something they can open again, filter, or click
  - change, fix, or restyle an artifact they already have
---

# Build an artifact

An artifact is a small interactive React view that OpenWork compiles and publishes as its own MCP server. It runs as the person using it, with their own access and connections, and opens again with live data beside the chat and from Artifacts. Use “artifact” in replies to the person.

## Decide first

- Build an artifact when the person will come back to it or needs inputs, filters, or buttons. When one answer settles the question, answer in chat.
- One artifact does one job. Name its focal element before writing anything: the list, number, status, or button the person came for.
- A self-contained artifact, such as a calculator or checklist, binds no tools. Anything that shows or changes the person's data binds the tools it needs.

## Steps

1. Find the data and actions it needs, unless it is self-contained: search_capabilities with 2-4 keyword variants, then pick exact matches that create_app can bind. Prefer tools that only read (readOnly: true). When the data must be combined or computed each time, save a live Workflow first, as execute_capability_script describes, and time it as Make it fast says.
2. Call prepare_app with a title that names the outcome ("Open Linear issues", not "Dashboard"), one sentence on what the person sees and does, and those exact tools. It verifies them and returns their input schemas and a starter already wired to them.
3. Write the artifact from that starter. Keep its theme, state handling, and tool calls. Replace the general result view with the focal view, rename buttons to their outcome, and keep only the inputs the person needs.
4. Call create_app with the preparationId, the same tools, the complete React and CSS, and a textFallback of one or two sentences on what the artifact shows. If it fails, fix exactly what the error names and call create_app again with the same preparationId. Never fall back to a local HTML file, save_artifact_view, or config-object writes.
5. Reply in one or two sentences: what the artifact shows and one thing to try in it. OpenWork shows the build as it happens and opens the artifact, so do not narrate the steps, claim stages in prose, or paste the source. After create_app or update_app the artifact is already open and reloaded beside the chat: never ask the person to reopen it or say you have not seen it.

To change an artifact, keep its purpose and tools unless the person asks otherwise. Call read_app first: it returns app (the latest summary), reactSource, and cssSource, not tool input schemas. Copy app.revisionId into update_app's expectedRevisionId. Supply complete replacement React source, title, and textFallback; omit cssSource, description, or tools to keep them, or pass complete replacements.

## Source and tool rules

- An artifact needs no Workflow, output schema, or Automation. Each declared tool has a unique snake_case name, a description, and one exact capability from search_capabilities: a saved Workflow, a connection tool, or an OpenWork action that reads (GET). OpenWork actions are read-only here: to change OpenWork data, bind a saved Workflow that makes the change. Use mode live for a Workflow that reads input.runtime. Tools run as the person using the artifact. Set loadOnOpen: true on a tool that only reads the data the person asked to see but is not marked readOnly, such as a live Workflow or a connection tool without a read-only label, so the artifact loads it on open with no click. Never set it on a tool that sends, creates, updates, or deletes; OpenWork refuses it for tools known to write. A saved Workflow that only reads through a broad tool marked destructive, such as an API code executor, may set it too. It runs with no click on the account of whoever opens the artifact, so be sure it only reads.
- reactSource default-exports a component receiving { app, input, result, hostContext }: input is the launch input, and result is the launch CallToolResult (read result?.structuredContent), undefined until delivered. hostContext carries theme ("light" or "dark"), styles.variables (CSS variables such as --color-text-primary, --color-background-primary, --color-border-primary and --font-sans), and containerDimensions { maxHeight, width }. The component re-renders when the host sends them again after a change.
- React is injected: use React.useState and other React APIs without imports. Do not use fetch, browser or host globals, timers, dynamic code, external resources, URL-bearing elements, or <form>, <svg>, <style>, or <math> elements; use labeled inputs and type=button controls.
- When prepare_app's nextSteps lists built-in libraries, import only those, by name, and follow its note on drawing; otherwise use no imports. OpenWork bundles its own pinned copy, so never install packages or load scripts.
- A saved Workflow answers with its run receipt, { kind: "workflow", status, value, ... }: the data is its value. The starter's valueOf unwraps it; keep it, or read structuredContent.value yourself, or every section renders empty.
- Call only declared tools, with app.callServerTool({ name, arguments }): a Workflow or connection tool takes the capability's arguments, an OpenWork action { path, query, body }, and a live Workflow only an optional { timeZone }. Show a blocked state if app.getHostCapabilities()?.serverTools is absent.
- Once the launch result arrives (result is no longer undefined), call the read-only tools the focal view needs with the launch input, with no click, and show the data. OpenWork runs a call without a click only for a tool that needs no approval, once per open and once the artifact is on screen.
- An artifact opened without launch input often arrives with its data: result._meta["openwork/initialResults"] lists { name, arguments, loadedAt, result } for read-only tools that need no input. Show the entry whose name and arguments match the call the artifact would make instead of making it; call as usual when none matches. An entry marked kept matches this person's earlier snapshot, confirmed by this open's checked read. Show it and, if an older launch producer supplies a loadedAt over a minute old, load again behind it. The starter's loadWith does this; keep it.
- A dashboard keeps an artifact open and refreshes it by delivering a new launch result (a new result object, with _meta "openwork/launchedAt"). When result changes after the first one, load the same reads again with the current inputs, in the background: keep the data on screen, marked as refreshing, and never go back to placeholders. OpenWork runs each such reload once per refresh.
- A tool that changes something (send, create, update, delete) or needs approval runs only from its own button: OpenWork allows one such call per click. Never call a tool on every keystroke; load again on Enter or a button. If the host refuses a call because it needs approval (its error mentions approval), keep that button so the person can approve and try again.
- To show data instantly, pass _meta { "openwork/cache": "store" } on a call so OpenWork keeps its result when the tool is read-only. When app.getHostContext()?.experimental?.["openwork/result-cache"] is true, call the same tool and arguments with _meta { "openwork/cache": "read" } as the artifact opens, then load it live. That read runs no tool: OpenWork answers from this person's own storage with the last result (_meta "openwork/cached": true and "openwork/cachedAt"), or isError when none is kept. Make the read as soon as the inputs are known, without waiting for the launch result: a dashboard shows its saved artifact at once and answers the kept read as soon as it has confirmed the artifact may still read it, before the live load returns. If the live load fails, keep showing what the artifact already has, marked stale with its time; OpenWork drops the kept result, so the next open starts without it.

## Publication and results

- prepare_app verifies bindings without running tools or saving an artifact. It returns preparationId, title, tools with their input schemas and readOnly/kind/mode, starter { reactSource, cssSource }, and nextSteps. The starter wires an initial tool or tools, not necessarily every declaration; nextSteps names any remaining tools to wire.
- Pass prepare_app's preparationId so OpenWork shows this build as the artifact it prepared. It grants no access and skips no validation: create_app still checks bindings, compiles source, and saves the artifact. Older clients may omit it.
- A new artifact goes in a new private Plugin named after it unless the user names an existing pluginId. The Workflows its tools run join that Plugin, and sharing the Plugin shares the artifact and those Workflows. Updating publishes an immutable revision in that same Plugin and MCP server.
- create_app and update_app return app (summary, not source), input (empty launch input), mcpUrl, and normally launch { connectionId, toolName, resourceUri, arguments }. When OpenWork's catalog limit of 100 connections and artifacts prevents opening it, launch is omitted; its MCP URL still works in MCP clients. OpenWork opens an available built artifact in a sidebar tab; other hosts receive its MCP URL and text fallback.

## Starters

prepare_app picks one from the tools you declare. Each is also a resource you can read before you start:

- lookup (${appStarterResourceUri("lookup")}): every tool only reads. It loads when the artifact opens, with inputs filled from the launch input, shows the last result for them at once while it refreshes, and loads again on Enter or its button. For dashboards, lists, status boards, and search.
- action (${appStarterResourceUri("action")}): at least one tool changes data. Inputs, one primary button that makes one call, the outcome, and a read that loads on open and again from its own button.
- standalone (${appStarterResourceUri("standalone")}): no tools. Its logic runs on the inputs and the launch input. For calculators, converters, and planners.

## Make it fast

The first load comes before everything else in this guide. Design the read so the person sees real data within a few seconds of opening the artifact, then build the view around it.

- Time the read before you build the view: run it with execute_capability_script and compare executedAt with fetchedAt. Keep it under 3 seconds. An open waits up to 4 seconds to bring read-only data with the artifact; a slower read is discarded and run again, so the artifact opens late and its data arrives later still.
- Load what the focal view needs in one call: one tool, or one live Workflow that combines the sources, rather than several calls or a call that waits on another.
- Start independent reads together, never one after another. In Workflow code collect them in one Promise.all, or Promise.allSettled when one failure should not sink the rest: Promise.all(ids.map((id) => tools.x.y({ id }))). Async helpers run side by side too, so give each source its own, such as one that pages through a list, and start them together: Promise.all([listOrders(), listRefunds()]). ${SERIAL_FORMS[language]} When the artifact itself calls several tools, start those calls together the same way.
- Ask the source for less: a date window, a summary or report endpoint, and no expanded records the view does not show. Each page of records can add a second or more, so never page through history for a number the source can give you directly.
- When the whole picture cannot be fast, split it: a quick read for the focal view, and a slower tool for the detail that fills in behind it.
- Load on open. Opening the artifact is enough intent, from the chat, a dashboard, or the catalog, so its read-only data loads with no click; never leave an empty "click to load" state for data it can read. Clicks are for changes (send, create, update, delete) and anything that needs approval.
- Keep the starter's cached read: the last result for its inputs shows at once while the live load refreshes it, with its "Updated" time, and stays on screen, marked stale, if the refresh fails; OpenWork then forgets it, so the next open starts fresh.
- Let the launch input carry the record or filter, so the chat opens the artifact on it without a lookup first.
- Return only what the view shows: the top rows and a count, not full records.
- Show data the moment it arrives: no entrance animations, staggered reveals, or chart draw-in (recharts isAnimationActive={false}). Import a built-in library only when the view needs it: charts add about 400 KB to every open.

## What a good artifact looks like

- Its height is its content: the host grows the frame to fit, up to hostContext.containerDimensions.maxHeight. Never set a height, 100vh or 100% on the root, and add no scrolling areas inside; show the top rows and a count rather than everything. No automatic navigation.
- It reads well at every width it opens in: the chat, the side panel and narrow dashboard tiles. Keep the starter's root container (container-type: inline-size) and adapt with @container rules, never viewport units or fixed widths.
- At most two primary actions. The main one sits right after the inputs it uses and spans the width when narrow; anything else is a quiet link.
- The host already shows the artifact's title, so do not repeat it as a heading or add a paragraph explaining the artifact. Report state instead: "12 open issues · updated 9:41".
- Every state is designed. Loading keeps the layout with placeholder rows instead of "Loading…", and only until the first data shows: a refresh keeps the data on screen with its "Updated" time and a quiet "Refreshing…". Empty says what to try. An error says what happened and what to do next. Blocked is neutral and says why.
- Buttons name their outcome ("Create invoice", "Find orders") in sentence case. No tool names, ids, or JSON on screen.
- Colors and fonts come from the host theme the starter applies, such as var(--color-text-primary) and var(--color-border-primary), with system colors (CanvasText, Canvas) as fallbacks, so it follows light and dark by itself. No hard-coded colors, gradients, emoji, or decorative badges.
- The launch input fills the artifact's inputs, so the chat can open it on a specific record.
`
}

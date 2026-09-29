import { Plugin } from "@opencode-ai/plugin/tui";
import { Schema } from "effect";
import { SessionTransfer } from "@opencode-ai/schema/session-transfer";
import { For, Show, createSignal, onMount } from "solid-js";
import { continueLegacyThread, type LegacyRead, type LegacyThreadSummary } from "./service.mjs";
import { legacyRpc } from "./rpc.js";
type Context = Plugin.Context;

function text(value: unknown) { return typeof value === "string" ? value : ""; }
function BrowserPage({ context }: { context: Context }) {
  const rpc = context.client.rpc(legacyRpc);
  const [rows, setRows] = createSignal<LegacyThreadSummary[]>([]);
  const [next, setNext] = createSignal<string | null>(null);
  const [search, setSearch] = createSignal("");
  const [opened, setOpened] = createSignal<LegacyRead | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  async function perform(operation: () => Promise<void>) {
    if (busy()) return;
    setBusy(true); setError("");
    try { await operation(); } catch (failure) { setError(failure instanceof Error ? failure.message : "V1 history is unavailable."); }
    finally { setBusy(false); }
  }
  async function load(before?: string) {
    const page = await rpc.list({ limit: 100, search: search(), before }, { location: context.location });
    setRows(before ? [...rows(), ...page.data] : page.data); setNext(page.nextCursor); setOpened(null);
  }
  async function select() {
    const selected = await context.ui.dialog.select({ title: "V1 chats", placeholder: "Search this page", options: rows().map(row => ({ title: row.title, description: row.directory, value: row.id })) });
    if (selected) setOpened(await rpc.read({ reference: selected, limit: 100 }, { location: context.location }));
  }
  async function convert() {
    const current = opened(); if (!current) return;
    const plan = await rpc.prepareImport({ reference: current.session.id }, { location: context.location });
    const confirmed = await context.ui.dialog.confirm({ title: "Continue in v2", message: ["Convert this conversation and its related chats with OpenCode's native migration logic. The v1 original stays unchanged.", ...plan.resets, ...plan.warnings.map(warning => warning.message)].join("\n"),
      label: { confirm: plan.warnings.length ? "Continue with omissions" : "Continue in v2" } });
    if (!confirmed) return;
    const result = await continueLegacyThread(plan, {
      key: "cli-native-import",
      get: async sessionID => {
        try { return await context.client.session.get({ sessionID }); }
        catch (failure) {
          if (failure !== null && typeof failure === "object" && "status" in failure && failure.status === 404) return null;
          throw failure;
        }
      },
      import: payload => {
        const validated = { ...Schema.encodeSync(SessionTransfer.Data)(Schema.decodeUnknownSync(SessionTransfer.Data)(payload)), location: payload.location };
        // Beta's generated client uses mutable JSON arrays; its native schema uses
        // readonly arrays. Both encode the same validated JSON on the wire.
        return context.client.session.import(validated as Parameters<Context["client"]["session"]["import"]>[0]);
      },
    }, { allowOmissions: plan.warnings.length > 0 });
    context.data.session.invalidate(result.sessionID);
    context.ui.router.navigate({ type: "session", sessionID: result.sessionID });
  }
  context.keymap.layer(() => ({ enabled: context.ui.router.current().type === "plugin", commands: [
    { id: "legacy.history.search", title: "Search v1 chats", palette: true, bind: "ctrl+f", run: () => perform(async () => { const query = await context.ui.dialog.prompt({ title: "Search v1 chats", value: search() }); if (query !== undefined) { setSearch(query); await load(); } }) },
    { id: "legacy.history.select", title: "Open v1 chat", palette: true, bind: "enter", run: () => perform(select) },
    { id: "legacy.history.continue", title: "Continue in v2", palette: true, enabled: () => Boolean(opened()), run: () => perform(convert) },
    { id: "legacy.history.more", title: "Load more v1 chats", palette: true, enabled: () => Boolean(next()), run: () => perform(async () => { const cursor = next(); if (cursor) await load(cursor); }) },
    { id: "legacy.history.read-more", title: "Read older v1 messages", palette: true, enabled: () => Boolean(opened()?.nextCursor), run: () => perform(async () => { const current = opened(); if (!current?.nextCursor) return; const older = await rpc.read({reference:current.session.id,before:current.nextCursor,limit:100},{location:context.location});setOpened({...older,data:[...older.data,...current.data]}); }) },
  ] }));
  onMount(() => void perform(() => load()));
  return <box flexDirection="column" flexGrow={1} padding={2}>
    <text fg={context.theme.text}>V1 history · read only</text>
    <text fg={context.theme.textMuted}>Enter to choose a chat · Ctrl+F to search · command palette to continue in v2</text>
    <Show when={error()}><text fg={context.theme.error}>{error()}</text></Show>
    <Show when={busy()}><text>Loading…</text></Show>
    <scrollbox flexGrow={1}>
      <Show when={opened()} fallback={<For each={rows()}>{row => <text onMouseDown={() => void perform(async () => { setOpened(await rpc.read({reference:row.id,limit:100},{location:context.location})); })}>{row.title} · v1 history</text>}</For>}>
        {current => <><text>{current().session.title}</text><For each={current().data}>{message => <box flexDirection="column" marginTop={1}><text>{text(message.info.role)}</text><For each={message.parts}>{part => <text>{part.type === "text" || part.type === "reasoning" ? text(part.text) : JSON.stringify(part)}</text>}</For></box>}</For></>}
      </Show>
    </scrollbox>
  </box>;
}

export default Plugin.define({
  id: "openwork.legacy-history",
  setup(context) {
    const unregister = context.ui.router.register({ name: "legacy-history", render: () => <BrowserPage context={context} /> });
    context.keymap.layer(() => ({ commands: [{ id: "legacy.history.browse", title: "Browse v1 chats", group: "History", palette: true, slash: { name: "v1-chats" }, run: () => context.ui.router.navigate({ type: "plugin", name: "legacy-history" }) }] }));
    return unregister;
  },
});

/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { copyMessage, serializeRenderedMessage, type MessageCopyRequest } from "../src/components/chat/message-clipboard";
import { copyAssistantProseSelection } from "../src/components/markdown/assistant-prose-clipboard";
import { AssistantProse } from "../src/components/markdown/assistant-prose";
import { dispatchMenuAction, serializeMenuActions } from "../src/components/ui/action-menu-model";

const ownedDom = !GlobalRegistrator.isRegistered;
let createRoot: typeof import("react-dom/client")["createRoot"];
let actions: typeof import("../src/components/chat/message-copy-actions");
let tooltip: typeof import("../src/components/ui/tooltip");
let root: Root | undefined;
let host: HTMLElement;
let originalClipboard: PropertyDescriptor | undefined;
let originalItem: PropertyDescriptor | undefined;
const writes: Array<Record<string, Blob>> = [];
const plainWrites: string[] = [];
class TestClipboardItem {
  constructor(public data: Record<string, Blob>) { writes.push(data); }
}
let write = mock(async (_items: ClipboardItem[]) => {});
let writeText = mock(async (text: string) => { plainWrites.push(text); });
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  createRoot = (await import("react-dom/client")).createRoot;
  actions = await import("../src/components/chat/message-copy-actions");
  tooltip = await import("../src/components/ui/tooltip");
});
beforeEach(() => {
  writes.length = 0; plainWrites.length = 0;
  write = mock(async (_items: ClipboardItem[]) => {});
  writeText = mock(async (text: string) => { plainWrites.push(text); });
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  originalItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write, writeText } });
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem });
  host = document.createElement('div'); document.body.append(host);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount()); root = undefined;
  document.getSelection()?.removeAllRanges(); document.body.replaceChildren();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard); else Reflect.deleteProperty(navigator, 'clipboard');
  if (originalItem) Object.defineProperty(globalThis, 'ClipboardItem', originalItem); else Reflect.deleteProperty(globalThis, 'ClipboardItem');
});
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });
function request(html = '<p>Hello <em>world</em></p><ul><li>One</li></ul><p>Expected: gap</p>'): MessageCopyRequest {
  const element = document.createElement('div'); element.innerHTML = html; host.append(element);
  const markdown = 'Hello *world*\n\n- One\n\nExpected: gap';
  return { markdown, source: markdown, enabled: true, getProse: () => [{ element, source: markdown }] };
}
async function payload() {
  const data = writes.at(-1)!;
  return { html: await data['text/html'].text(), text: await data['text/plain'].text() };
}
async function mount(request: MessageCopyRequest) {
  root = createRoot(host.appendChild(document.createElement('div')));
  const { MessageCopyButton } = actions; const { TooltipProvider } = tooltip;
  await act(async () => root?.render(<TooltipProvider><MessageCopyButton request={request} /></TooltipProvider>));
}
async function clickCopy() {
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click(); });
}

describe('message Copy', () => {
  test('flag on writes both Blob flavors using the existing serializer', async () => {
    const r = request(); expect(await copyMessage(r)).toBe('rich');
    expect(write).toHaveBeenCalledTimes(1); expect(write.mock.calls[0]?.[0]).toHaveLength(1);
    expect(writeText).not.toHaveBeenCalled();
    expect(writes[0]?.['text/html'].type).toBe('text/html'); expect(writes[0]?.['text/plain'].type).toBe('text/plain');
    expect(await payload()).toEqual({ html: '<p style="margin:0">Hello <em>world</em></p><p style="margin:0"><br></p><ul style="margin:0"><li style="margin:0">One</li></ul><p style="margin:0"><br></p><p style="margin:0">Expected: gap</p>', text: 'Hello world\n\n• One\n\nExpected: gap' });
  });
  test('flag off writes exact legacy Markdown without reading DOM or rich APIs', async () => {
    const r = request(); r.enabled = false; r.markdown = '  **exact**\n\n[source](file:///tmp/a)\n'; r.getProse = () => { throw Error('must not inspect'); };
    expect(await copyMessage(r)).toBe('markdown'); expect(plainWrites).toEqual([r.markdown]); expect(write).not.toHaveBeenCalled();
  });
  test.each(['serializer null', 'missing element', 'unmounted element', 'missing ClipboardItem', 'missing write', 'constructor throws', 'write rejects', 'DOM lookup throws', 'partial source'])('fallback writes exact Markdown: %s', async reason => {
    const r = request();
    if (reason === 'serializer null') r.getProse!()[0]!.element.innerHTML = '<p><span class="katex">math</span></p>';
    if (reason === 'missing element') r.getProse = () => [];
    if (reason === 'unmounted element') r.getProse!()[0]!.element.remove();
    if (reason === 'missing ClipboardItem') Object.defineProperty(globalThis, 'ClipboardItem', {configurable:true,value:undefined});
    if (reason === 'missing write') Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText}});
    if (reason === 'constructor throws') Object.defineProperty(globalThis, 'ClipboardItem', {configurable:true,value:class { constructor() { throw Error('format rejected'); } }});
    if (reason === 'write rejects') write.mockRejectedValue(new Error('denied'));
    if (reason === 'DOM lookup throws') r.getProse = () => { throw Error('unmounted'); };
    if (reason === 'partial source') r.source += ' Missing second message';
    expect(await copyMessage(r)).toBe('markdown'); expect(plainWrites).toEqual([r.markdown]);
  });
  test('different panes cannot be combined; source completeness prevents partial replies', () => {
    const r = request(); const elements = r.getProse!();
    expect(serializeRenderedMessage(elements, r.source + 'other pane')).toBeNull();
    expect(serializeRenderedMessage([], r.source)).toBeNull();
  });
  test('a whole reply copies in DOM order, not ref registration order', async () => {
    const r = request('<p>First</p>'); const first = r.getProse!()[0]!.element;
    const last = document.createElement('div'); last.innerHTML = '<p>Last</p>'; host.append(last);
    r.source = 'FirstLast'; r.getProse = () => [{element:last,source:'Last'},{element:first,source:'First'}];
    expect(await copyMessage(r)).toBe('rich'); expect((await payload()).text).toBe('First\n\nLast');
  });
  test.each([false, true])('real React button gates clipboard route: enabled=%s', async enabled => {
    const r = request(); r.enabled = enabled; await mount(r); await clickCopy();
    expect(write).toHaveBeenCalledTimes(enabled ? 1 : 0); expect(plainWrites).toEqual(enabled ? [] : [r.markdown]);
    expect(host.querySelector('[aria-label="Copy message"] svg')).not.toBeNull();
  });
  test('real button falls back when the rendered reply goes away before click', async () => {
    const r = request(); await mount(r); r.getProse!()[0]!.element.remove(); await clickCopy();
    expect(plainWrites).toEqual([r.markdown]); expect(write).not.toHaveBeenCalled();
  });
  test('even Markdown failure preserves quiet button behavior', async () => {
    const r = request(); r.enabled = false; writeText.mockRejectedValue(new Error('denied')); await mount(r); await clickCopy();
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});

describe('message menus', () => {
  test('message menu exposes only the existing Copy action', () => {
    expect(serializeMenuActions(actions.messageCopyActions(request())).map(item => item.type === 'item' ? item.label : '')).toEqual(['Copy']);
  });
  test('Copy menu uses the rich route when enabled', async () => {
    const r = request(); const menu = actions.messageCopyActions(r);
    expect(await dispatchMenuAction(menu,'copy')).toBe(true); expect(write).toHaveBeenCalledTimes(1);
    expect(plainWrites).toEqual([]);
  });
  test('off menu Copy keeps the exact Markdown source', async () => {
    const r = request(); r.enabled = false; r.markdown = ' **source**\n\n- exact\n';
    expect(await dispatchMenuAction(actions.messageCopyActions(r),'copy')).toBe(true); expect(plainWrites).toEqual([r.markdown]);
  });
});

describe('committed rendered source', () => {
  test('held selection through streaming completion cannot approve stale partial DOM', async () => {
    const { MessageContent } = await import('../src/components/ui/message');
    const registry = new Map<HTMLElement,string>();
    const committed = (element:HTMLElement,source:string) => { registry.set(element,source); return () => { registry.delete(element); }; };
    root = createRoot(host);
    await act(async () => root?.render(<MessageContent markdown isStreaming onRenderedMarkdown={committed}>First</MessageContent>));
    expect(host.textContent).toBe('First');
    const node = document.createTreeWalker(host, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange(); range.setStart(node,0); range.setEnd(node,5); document.getSelection()!.addRange(range);
    await act(async () => root?.render(<MessageContent markdown isStreaming={false} onRenderedMarkdown={committed}>First and completed</MessageContent>));
    expect(host.textContent).toBe('First'); expect([...registry.values()]).toEqual(['First']);
    const r: MessageCopyRequest = {markdown:'First and completed',source:'First and completed',enabled:true,getProse:()=>[...registry].map(([element,source])=>({element,source}))};
    expect(await copyMessage(r)).toBe('markdown'); expect(plainWrites).toEqual(['First and completed']);
    await act(async () => { document.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
    expect(host.textContent).toBe('First and completed'); expect([...registry.values()]).toEqual(['First and completed']);
    expect(await copyMessage(r)).toBe('rich'); expect((await payload()).text).toBe('First and completed');
    await act(async () => root?.unmount()); root=undefined; expect(registry.size).toBe(0);
  });
});

describe('whole-reply Cmd+C / button parity', () => {
  test.each(['separate messages','expanded split steps/answer'])('reply listener bridges physical message roots: %s', async scenario => {
    root = createRoot(host); const groups:HTMLElement[]=[];
    await act(async () => root?.render(<div data-reply="" onCopy={event=>{copyAssistantProseSelection(event.nativeEvent,event.currentTarget,true,true,groups);}}>
      <AssistantProse grouped enabled data-message-id={scenario==='separate messages'?'msg-1':'msg-1:steps'}><div data-assistant-reply-prose><p>First <em>answer</em></p></div></AssistantProse>
      <section>Activity outside both physical messages</section>
      <AssistantProse grouped enabled data-message-id={scenario==='separate messages'?'msg-2':'msg-1'}><div data-assistant-reply-prose><p>Last <a href="https://example.com">link</a></p></div></AssistantProse>
    </div>));
    groups.push(...host.querySelectorAll<HTMLElement>('[data-assistant-reply-prose]'));
    const first=groups[0]!.querySelector('p')!.firstChild!; const last=groups[1]!.querySelector('a')!.firstChild!;
    const range=document.createRange();range.setStart(first,0);range.setEnd(last,4);document.getSelection()!.addRange(range);
    const data=new Map<string,string>();const event=new Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{setData:(format:string,value:string)=>data.set(format,value)}});
    groups[0]!.querySelector('p')!.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);
    expect(data.get('text/plain')).toBe('First answer\n\nLast link (https://example.com)');
    const r:MessageCopyRequest={markdown:'First *answer*Last [link](https://example.com)',source:'First *answer*Last [link](https://example.com)',enabled:true,getProse:()=>[{element:groups[0]!,source:'First *answer*'},{element:groups[1]!,source:'Last [link](https://example.com)'}]};
    await copyMessage(r);expect(await payload()).toEqual({html:data.get('text/html')!,text:data.get('text/plain')!});
    const outside=document.createElement('p');outside.textContent='Other reply';document.body.append(outside);range.setEnd(outside.firstChild!,3);document.getSelection()!.removeAllRanges();document.getSelection()!.addRange(range);
    const native=new Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(native,'clipboardData',{value:{setData:()=>{throw Error('must remain native');}}});groups[0]!.querySelector('p')!.dispatchEvent(native);expect(native.defaultPrevented).toBe(false);
  });
  test('both clipboard formats are byte-identical across prose → tool → prose', async () => {
    const message = document.createElement('div'); host.append(message);
    message.innerHTML = '<div data-assistant-reply-prose><h3>Subject</h3><p>Intro <em>italic</em> <a href="https://example.com">link</a>.</p></div><section>Tool output is not prose</section><div data-assistant-reply-prose><ul><li>One</li><li>Two</li></ul><p><strong>Expected:</strong> gap</p></div>';
    const groups = [...message.children].filter((e): e is HTMLElement => e instanceof HTMLElement && e.hasAttribute('data-assistant-reply-prose'));
    const markdown = '### Subject\n\nIntro *italic* [link](https://example.com).\n\n- One\n- Two\n\n**Expected:** gap';
    const r: MessageCopyRequest = {markdown,source:markdown,enabled:true,getProse:()=>groups.map((element,i)=>({element,source:i===0?markdown:''}))};
    const range = document.createRange(); range.selectNodeContents(message); document.getSelection()!.addRange(range);
    const selected = new Map<string,string>(); let cancelled = false;
    expect(copyAssistantProseSelection({target:groups[0]!,defaultPrevented:false,clipboardData:{setData:(format,data)=>{selected.set(format,data);}},preventDefault:()=>{cancelled=true;}},message,true,true)).toBe(true);
    expect(cancelled).toBe(true);
    await mount(r); await clickCopy();
    expect(await payload()).toEqual({html:selected.get('text/html')!,text:selected.get('text/plain')!});
    expect((await payload()).text).not.toContain('Tool output');
  });
});

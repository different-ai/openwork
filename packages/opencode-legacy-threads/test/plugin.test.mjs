import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { testRender } from "@opentui/solid";
import serverPlugin from "../src/plugin.ts";
import tuiPlugin from "../dist/tui.js";
import { legacyRpc } from "../src/rpc.ts";
import { fixture } from "./fixture.mjs";

test("server RPC registers strict workspace-scoped read and selective prepare methods",async()=>{
  const f=await fixture();
  try {
    f.session("ses_fixture");f.message("msg_fixture","ses_fixture",f.user);f.part("prt_fixture","msg_fixture","ses_fixture",{type:"text",text:"RPC fixture text"});
    let handlers;let disposed=false;
    const cleanup=await serverPlugin.setup({options:{legacyDatabase:f.source},location:{directory:f.directory},rpc:{register:async(definition,value)=>{expect(definition.id).toBe("openwork.legacy-history");handlers=value;return{dispose:async()=>{disposed=true;}};}}});
    const ctx={error:(type,message,data)=>({type,message,data})};
    const list=await handlers.list({},ctx);expect(list.data).toHaveLength(1);
    expect((await handlers.read({reference:list.data[0].id},ctx)).data[0].parts[0].text).toBe("RPC fixture text");
    expect((await handlers.prepareImport({reference:list.data[0].id},ctx)).sessions).toHaveLength(1);
    expect(legacyRpc.methods.list.input.safeParse({legacyDatabase:"/foreign"}).success).toBe(false);
    await cleanup();expect(disposed).toBe(true);
  } finally {await f.close();}
});

test("CLI browser renders a preview, imports once through the native client, and navigates",async()=>{
  const f=await fixture();let rendered;let dispose;
  try {
    f.session("ses_fixture");f.message("msg_fixture","ses_fixture",f.user);f.part("prt_fixture","msg_fixture","ses_fixture",{type:"text",text:"Retained CLI fact"});
    let handlers;await serverPlugin.setup({options:{legacyDatabase:f.source},location:{directory:f.directory},rpc:{register:async(_,value)=>{handlers=value;return{dispose:async()=>{}};}}});
    const rpc={list:input=>handlers.list(input,{}),read:input=>handlers.read(input,{}),prepareImport:input=>handlers.prepareImport(input,{})};
    const list=await rpc.list({});const native=new Map();let writes=0;const layers=[];const pages=[];const navigations=[];
    const context={location:{directory:f.directory},theme:{text:"#ffffff",textMuted:"#aaaaaa",error:"#ff5555"},client:{rpc:()=>rpc,session:{get:async({sessionID})=>{if(!native.has(sessionID))throw{status:404};return native.get(sessionID);},import:async payload=>{writes++;native.set(payload.info.id,payload.info);return payload.info;}}},data:{session:{invalidate(){}}},keymap:{layer:fn=>layers.push(fn)},ui:{router:{register:page=>{pages.push(page);return()=>{};},navigate:destination=>navigations.push(destination),current:()=>({type:"plugin",name:"legacy-history"})},dialog:{select:async()=>list.data[0].id,confirm:async()=>true,prompt:async()=>"fixture"}}};
    createRoot(end=>{dispose=end;tuiPlugin.setup(context);});
    await layers[0]().commands[0].run();expect(navigations[0]).toEqual({type:"plugin",name:"legacy-history"});
    rendered=await testRender(()=>pages[0].render({}),{width:100,height:30});await rendered.waitForFrame(frame=>frame.includes("ses_fixture"));expect(writes).toBe(0);
    const commands=()=>layers.flatMap(fn=>fn().commands??[]);
    await commands().find(command=>command.id==="legacy.history.select").run();await rendered.waitForFrame(frame=>frame.includes("Retained CLI fact"));expect(writes).toBe(0);
    await commands().find(command=>command.id==="legacy.history.continue").run();expect(writes).toBe(1);expect(navigations.at(-1)).toEqual({type:"session",sessionID:"ses_fixture"});
    await commands().find(command=>command.id==="legacy.history.continue").run();expect(writes).toBe(1);
  } finally {rendered?.renderer.destroy();dispose?.();await f.close();}
});

/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
GlobalRegistrator.register({url:"http://localhost"});
Object.defineProperty(globalThis,"IS_REACT_ACT_ENVIRONMENT",{configurable:true,value:true});
const { createRoot }=await import("react-dom/client");
const { LegacyConversionNotice }=await import("../src/react-app/domains/session/surface/legacy-conversion-notice");
let host:HTMLDivElement;let root:ReturnType<typeof createRoot>;
const originalFetch=globalThis.fetch;
const ref="v1:0123456789abcdef01234567:ses_fixture";
afterAll(async()=>{await GlobalRegistrator.unregister();});
beforeEach(()=>{host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();globalThis.fetch=originalFetch;});
function button(){const node=host.querySelector("button");if(!node)throw new Error("Conversion button missing");return node;}
test("warning performs no conversion on preview; clicking converts through the owning host",async()=>{
  const calls:Request[]=[];const converted:string[]=[];
  globalThis.fetch=async(input,init)=>{const req=new Request(input,init);calls.push(req);return Response.json(req.method==="GET"?{warnings:[],resets:[],converterVersion:"0.0.0-beta-19086",sessions:1}:{sessionID:"ses_fixture"});};
  await act(async()=>root.render(<LegacyConversionNotice baseUrl="http://localhost/workspace/ws/opencode2" directory="/fixture" sessionId={ref} token="fixture-token" onConverted={id=>converted.push(id)}/>));
  expect(host.textContent).toContain("Convert this v1 chat before sending");expect(calls).toHaveLength(0);
  await act(async()=>button().click());
  expect(calls.map(req=>new URL(req.url).pathname)).toEqual([`/workspace/ws/legacy-history/session/${encodeURIComponent(ref)}/prepare`,`/workspace/ws/legacy-history/session/${encodeURIComponent(ref)}/continue`]);
  expect(calls[1]?.headers.get("Authorization")).toBe("Bearer fixture-token");expect(await calls[1]?.json()).toEqual({confirm:true,allowOmissions:false});expect(converted).toEqual(["ses_fixture"]);
});
test("known omissions require a labeled second action and failed imports stay retryable",async()=>{
  const calls:Request[]=[];let attempts=0;const converted:string[]=[];
  globalThis.fetch=async(input,init)=>{const req=new Request(input,init);calls.push(req);if(req.method==="GET")return Response.json({warnings:[{message:"A linked attachment is unavailable."}],resets:[],converterVersion:"0.0.0-beta-19086",sessions:2});attempts++;return attempts===1?Response.json({message:"A different v2 chat already uses this ID."},{status:409}):Response.json({sessionID:"ses_fixture"});};
  await act(async()=>root.render(<LegacyConversionNotice baseUrl="http://localhost/workspace/ws/opencode2" directory="/fixture" sessionId={ref} onConverted={id=>converted.push(id)}/>));
  await act(async()=>button().click());expect(attempts).toBe(0);expect(button().textContent).toBe("Continue with omissions");expect(host.textContent).toContain("A linked attachment");
  await act(async()=>button().click());expect(converted).toHaveLength(0);expect(host.querySelector('[role="alert"]')?.textContent).toContain("different v2 chat");
  await act(async()=>button().click());expect(converted).toEqual(["ses_fixture"]);expect(await calls.at(-1)?.json()).toEqual({confirm:true,allowOmissions:true});
});

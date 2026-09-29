import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fixture } from "../../../packages/opencode-legacy-threads/test/fixture.mjs";
import { startServer } from "./server.js";
import * as engine from "./engine-v2-preview.js";
import type { ServerConfig } from "./types.js";

test("host routes authenticate, fence workspace history, reject paths and virtual native IDs, and selectively import",async()=>{
  const f=await fixture();const oldSource=process.env.OPENCODE_DB;
  process.env.OPENCODE_DB=f.source;
  const native=new Map<string,unknown>();let imports=0;let calls=0;
  const target=Bun.serve({port:0,fetch:async request=>{
    calls++;const path=new URL(request.url).pathname;
    if(path==="/api/session/import"){imports++;const payload:unknown=await request.json();if(!isRecord(payload)||!isRecord(payload.info)||typeof payload.info.id!=="string")return Response.json({},{status:400});native.set(payload.info.id,payload.info);return Response.json({data:payload.info});}
    const id=path.split("/")[3]??"";
    if(path.endsWith("/message"))return Response.json({data:[],cursor:{next:null}});
    return native.has(id)?Response.json({data:native.get(id)}):Response.json({message:"Not found"},{status:404});
  }});
  const status=():engine.EngineV2PreviewStatus=>({enabled:true,running:true,chatRouting:true,mirroredProviderIds:[],skippedProviderIds:[],catalogModelIds:[],migration:{state:"idle",imported:0,skipped:0,total:0}});
  const preview=spyOn(engine,"createEngineV2Preview").mockReturnValue({start(){},status,migrateHistory:status,setEnabled:async()=>status(),setChatRouting:async()=>status(),connection:()=>({url:`http://127.0.0.1:${target.port}`,username:"opencode",password:"fixture"}),ensureWorkspaceReady:async()=>{},refreshProviders:async()=>{},syncWorkspaceMcp:async()=>{},warmWorkspace(){},settleWorkspaceSkills:async()=>{},stop:async()=>{}});
  const config:ServerConfig={host:"127.0.0.1",port:0,token:"owt_fixture",hostToken:"owt_host",configPath:join(f.root,"server.json"),approval:{mode:"auto",timeoutMs:1000},corsOrigins:["*"],workspaces:[{id:"ws",name:"Fixture",path:f.directory,preset:"starter",workspaceType:"local"},{id:"other",name:"Other",path:f.other,preset:"starter",workspaceType:"local"}],authorizedRoots:[f.directory,f.other],readOnly:false,startedAt:Date.now(),tokenSource:"cli",hostTokenSource:"cli",logFormat:"pretty",logRequests:false};
  let server:Awaited<ReturnType<typeof startServer>>|undefined;
  try {
    f.session("ses_parent");f.session("ses_child","ses_parent",f.other);f.session("ses_private",null,f.other);
    f.message("msg_fact","ses_parent",f.user);f.part("prt_fact","msg_fact","ses_parent",{type:"text",text:"retained fixture"});
    server=await startServer(config);
    const request=(path:string,body?:unknown)=>fetch(`http://127.0.0.1:${server?.port}${path}`,{method:body?"POST":"GET",headers:{Authorization:"Bearer owt_fixture","Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
    expect((await fetch(`http://127.0.0.1:${server.port}/workspace/ws/legacy-history/session`)).status).toBe(401);
    const listed=await request("/workspace/ws/legacy-history/session?legacyDatabase=/foreign&directory=/foreign");expect(listed.status).toBe(200);
    const rows:unknown=await listed.json();if(!Array.isArray(rows))throw new Error("Expected list");expect(rows.map(row=>isRecord(row)?row.title:null).sort()).toEqual(["ses_child","ses_parent"]);
    const parent=rows.find(row=>isRecord(row)&&row.title==="ses_parent");if(!isRecord(parent)||typeof parent.id!=="string")throw new Error("Expected parent");
    const path=`/workspace/ws/legacy-history/session/${encodeURIComponent(parent.id)}`;
    expect((await request(`${path}/message`)).status).toBe(200);expect(imports).toBe(0);expect(calls).toBe(0);
    expect((await request(`/workspace/other/legacy-history/session/${encodeURIComponent(parent.id)}/message`)).status).toBe(404);
    expect((await request(`${path}/continue`,{confirm:true,legacyDatabase:f.source})).status).toBe(400);
    const nativeCalls=calls;expect((await request(`/workspace/ws/opencode2/api/session/${encodeURIComponent(parent.id)}/message`)).status).toBe(409);expect(calls).toBe(nativeCalls);
    const prepare=await request(`${path}/prepare`);expect(prepare.status).toBe(200);expect(imports).toBe(0);
    const results=await Promise.all([request(`${path}/continue`,{confirm:true}),request(`${path}/continue`,{confirm:true})]);expect(results.map(result=>result.status)).toEqual([200,200]);expect(imports).toBe(2);expect(native.has("ses_private")).toBe(false);
    expect((await request(`${path}/continue`,{confirm:true})).status).toBe(200);expect(imports).toBe(2);
    native.set("ses_parent",{id:"ses_parent",location:{directory:f.directory},metadata:{}});
    expect((await request(`${path}/continue`,{confirm:true})).status).toBe(409);expect(imports).toBe(2);
    const source=new Database(f.source,{readonly:true});expect(source.query("SELECT count(*) AS n FROM session").get()).toEqual({n:3});source.close();
  } finally {await server?.stop();preview.mockRestore();target.stop(true);if(oldSource===undefined)delete process.env.OPENCODE_DB;else process.env.OPENCODE_DB=oldSource;await f.close();}
});

function isRecord(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==="object"&&!Array.isArray(value);}

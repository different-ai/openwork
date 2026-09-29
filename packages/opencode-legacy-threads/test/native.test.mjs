import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createManagedOpencodeServer } from "../../../apps/server/src/managed-opencode.ts";
import { createManagedOpencodeV2Server } from "../../../apps/server/src/managed-opencode-v2.ts";
import { snapshotV1Database } from "../../../apps/server/src/opencode-v2-migration.ts";
import { createLegacyHistoryService, continueLegacyThread } from "../src/service.mjs";

const bin = process.env.OPENWORK_OPENCODE2_BIN;
const v1bin = process.env.OPENWORK_MIGRATION_V1_BIN;
test.skipIf(!bin || !v1bin)("matches the pinned native migration and continues an imported fact across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-legacy-native-"));
  const directory = join(root,"workspace");const home=join(root,"home");const source=join(root,"v1.db");const canary=join(directory,"historical-tool-executed");
  await mkdir(directory);await mkdir(home);
  const env={HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:join(home,"config"),XDG_DATA_HOME:join(home,"data"),XDG_CACHE_HOME:join(home,"cache"),XDG_STATE_HOME:join(home,"state"),OPENCODE_DISABLE_MODELS_FETCH:"1",OPENCODE_PURE:"true",OPENCODE_DB:source};
  let v1,converter,target; let witness;
  try {
    v1=await createManagedOpencodeServer({bin:v1bin,cwd:directory,env});
    const headers={Authorization:`Basic ${Buffer.from(`${v1.username}:${v1.password}`).toString("base64")}`,"Content-Type":"application/json"};
    const create=async body=>{const response=await fetch(`${v1.url}/session`,{method:"POST",headers,body:JSON.stringify(body)});expect(response.status).toBe(200);return response.json();};
    const parent=await create({title:"Fixture parent"});const selected=await create({title:"Fixture selected",parentID:parent.id});const child=await create({title:"Fixture child",parentID:selected.id});const unrelated=await create({title:"Unrelated history"});
    await v1.close();
    const db=new Database(source);const now=Date.now();
    const message=(id,value,time=now)=>db.prepare("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)").run(id,selected.id,time,time,JSON.stringify(value));
    const part=(id,mid,value)=>db.prepare("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)").run(id,mid,selected.id,now,now,JSON.stringify(value));
    const user={role:"user",time:{created:now},agent:"openwork",model:{providerID:"fixture",modelID:"fixture"}};
    const assistant=parentID=>({role:"assistant",parentID,time:{created:now+1,completed:now+2},modelID:"fixture",providerID:"fixture",agent:"openwork",mode:"build",path:{cwd:directory,root:directory},cost:0.2,tokens:{input:1,output:2,reasoning:0,cache:{read:0,write:0}},finish:"stop"});
    message("msg_user",user);part("prt_text","msg_user",{type:"text",text:"The secret fixture phrase is violet lantern."});part("prt_synthetic","msg_user",{type:"text",synthetic:true,text:"Synthetic fixture context."});part("prt_file","msg_user",{type:"file",mime:"text/plain",filename:"fixture.txt",url:"data:text/plain;base64,aGVsbG8="});
    message("msg_assistant",assistant("msg_user"),now+1);part("prt_tool","msg_assistant",{type:"tool",callID:"call1",tool:"read",state:{status:"completed",input:{path:"fixture"},output:"violet lantern",title:"Read",metadata:{},time:{start:now+1,end:now+2}}});part("prt_interrupted","msg_assistant",{type:"tool",callID:"call2",tool:"bash",state:{status:"running",input:{command:"touch historical-tool-executed"},time:{start:now+1}}});
    message("msg_compact",user,now+2);part("prt_compact","msg_compact",{type:"compaction",auto:true,tail_start_id:"msg_user"});message("msg_summary",{...assistant("msg_compact"),summary:true},now+3);part("prt_summary","msg_summary",{type:"text",text:"The fixture phrase is violet lantern."});
    db.close();
    const hash=async()=>createHash("sha256").update(await readFile(source)).digest("hex");const before=await hash();
    const service=createLegacyHistoryService({legacyDatabase:source});const ref=(await service.list({directory,search:"Fixture selected"})).data[0].id;
    const plan=await service.prepareImport({directory,reference:ref});expect(plan.sessions.map(s=>s.info.id)).toEqual([parent.id,selected.id,child.id]);
    expect(plan.sessions[1].info.agent).toBe("openwork");
    const nativeRoot=join(root,"native");await mkdir(nativeRoot);await snapshotV1Database(source,join(nativeRoot,"opencode.db"));
    const engineEnv={...env};delete engineEnv.OPENCODE_DB;
    converter=await createManagedOpencodeV2Server({bin,rootDir:nativeRoot,env:engineEnv});
    const deadline=Date.now()+60_000;
    for(;;){const status=await converter.fetchJson("/api/experimental/migration/v1");if(status.json.status==="completed")break;if(status.json.status==="error"||Date.now()>deadline)throw new Error(`Native fixture migration failed: ${JSON.stringify(status.json)}`);await new Promise(resolve=>setTimeout(resolve,200));}
    for(const payload of plan.sessions){
      const native=await converter.fetchJson(`/api/session/${payload.info.id}/export`,{directory});expect(native.status).toBe(200);
      expect(payload.messages).toEqual(native.json.data.messages);
      for(const key of ["agent","model","cost","tokens","parentID"])expect(payload.info[key]).toEqual(native.json.data.info[key]);
    }
    await converter.close();converter=undefined;
    target=await createManagedOpencodeV2Server({bin,rootDir:join(root,"target"),env:{...engineEnv,OPENCODE_PURE:""}});
    const pluginConfig=join(root,"target","config","opencode.json");
    const config=JSON.parse(await readFile(pluginConfig,"utf8"));
    await writeFile(pluginConfig,JSON.stringify({...config,plugins:[{package:pathToFileURL(fileURLToPath(new URL("../",import.meta.url))).href,options:{legacyDatabase:source}}]}));
    const rpc=(method,input)=>target.fetchJson(`/api/rpc/openwork.legacy-history/${method}`,{method:"POST",directory,body:{input}});
    const rpcDeadline=Date.now()+20_000;let rpcList;
    for(;;){rpcList=await rpc("list",{});if(rpcList.status===200&&rpcList.json.output?.data)break;if(Date.now()>rpcDeadline)throw new Error(`Standalone RPC unavailable: ${JSON.stringify(rpcList.json)}; plugins: ${JSON.stringify((await target.fetchJson("/api/plugin",{directory})).json)}; ${target.stderr.slice(-1000)}`);await new Promise(resolve=>setTimeout(resolve,200));}
    const rpcSelected=rpcList.json.output.data.find(s=>s.id===ref);expect(rpcSelected).toBeDefined();
    expect((await rpc("read",{reference:ref})).json.output.data).toHaveLength(4);
    expect((await rpc("prepareImport",{reference:ref})).json.output.sessions.map(s=>s.info.id)).toEqual([parent.id,selected.id,child.id]);
    expect((await rpc("list",{legacyDatabase:"/foreign"})).status).toBe(400);
    const existing=await target.fetchJson("/api/session",{method:"POST",directory,body:{title:"Existing v2 chat",location:{directory}}});expect(existing.status).toBe(200);
    const nativeTarget={key:root,get:async id=>{const r=await target.fetchJson(`/api/session/${id}`,{directory});if(r.status===404)return null;if(r.status!==200)throw new Error(`Native get ${r.status}`);return r.json;},import:async payload=>{const r=await target.fetchJson("/api/session/import",{method:"POST",directory,body:payload});if(r.status!==200)throw new Error(`Native import ${r.status}: ${JSON.stringify(r.json)}`);return r.json;}};
    await Promise.all([continueLegacyThread(plan,nativeTarget),continueLegacyThread(plan,nativeTarget)]);
    await continueLegacyThread(plan,nativeTarget);
    expect((await target.fetchJson(`/api/session/${unrelated.id}`,{directory})).status).toBe(404);
    expect((await target.fetchJson(`/api/session/${existing.json.data.id}`,{directory})).json.data.title).toBe("Existing v2 chat");
    const modelRequests=[];
    witness=Bun.serve({port:0,fetch:async request=>{
      const body=await request.json();modelRequests.push(body);
      const output=JSON.stringify(body.messages).includes("violet lantern")?"violet lantern":"missing historical fact";
      const chunk=(delta,finish_reason=null)=>`data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",created:Math.floor(Date.now()/1000),model:"fixture",choices:[{index:0,delta,finish_reason}]})}\n\n`;
      return body.stream?new Response(chunk({role:"assistant",content:output})+chunk({},"stop")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}}):Response.json({id:"fixture",object:"chat.completion",model:"fixture",choices:[{index:0,message:{role:"assistant",content:output},finish_reason:"stop"}]});
    }});
    await target.injectProvider({id:"fixture",name:"Fixture",package:"@opencode-ai/ai/providers/openai-compatible",baseUrl:`http://127.0.0.1:${witness.port}/v1`,apiKey:"fixture",models:[{id:"fixture",name:"Fixture"}]});
    const catalogDeadline=Date.now()+20_000;
    for(;;){const catalog=await target.fetchJson("/api/model",{directory});if(JSON.stringify(catalog.json).includes('"providerID":"fixture"'))break;if(Date.now()>catalogDeadline)throw new Error("Fixture provider did not reach the native catalog");await new Promise(resolve=>setTimeout(resolve,200));}
    const model=await target.fetchJson(`/api/session/${selected.id}/model`,{method:"POST",directory,body:{model:{providerID:"fixture",id:"fixture"}}});expect(model.status).toBe(204);
    const eventAbort=new AbortController();const failures=[];
    const events=await fetch(`${target.url}/api/event?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,{headers:{Authorization:`Basic ${Buffer.from(`${target.username}:${target.password}`).toString("base64")}`},signal:eventAbort.signal});
    const eventRead=(async()=>{try{const reader=events.body.getReader();let buffered="";for(;;){const item=await reader.read();if(item.done)break;buffered+=new TextDecoder().decode(item.value);const entries=buffered.split("\n\n");buffered=entries.pop()??"";for(const entry of entries){const data=entry.split("\n").find(line=>line.startsWith("data:"));if(!data)continue;const event=JSON.parse(data.slice(5));if(String(event.type).includes("error")||String(event.type).includes("failed"))failures.push(event);}}}catch{}})();
    const prompt=await target.fetchJson(`/api/session/${selected.id}/prompt`,{method:"POST",directory,body:{text:"What is the fixture phrase?"},timeoutMs:60_000});expect(prompt.status>=200&&prompt.status<300).toBe(true);
    const exportDeadline=Date.now()+30_000;let exported;
    try{for(;;){exported=await target.fetchJson(`/api/session/${selected.id}/export`,{directory});if(exported.json.data.messages.some(m=>m.type==="assistant"&&m.id!=="msg_assistant"&&JSON.stringify(m).includes("violet lantern")))break;if(failures.length||Date.now()>exportDeadline)throw new Error(`Continuation failed: ${JSON.stringify(failures)}; ${target.stderr.slice(-1000)}; ${target.stdout.slice(-1500)}; requests: ${modelRequests.length}`);await new Promise(resolve=>setTimeout(resolve,200));}}finally{eventAbort.abort();await eventRead;}
    expect(modelRequests.some(body=>JSON.stringify(body.messages).includes("violet lantern"))).toBe(true);
    // The historical interrupted call can appear in context, but never runs.
    expect(await Bun.file(canary).exists()).toBe(false);
    await target.close();target=await createManagedOpencodeV2Server({bin,rootDir:join(root,"target"),env:engineEnv});
    const restarted=await target.fetchJson(`/api/session/${selected.id}/export`,{directory});expect(restarted.json.data.messages).toEqual(exported.json.data.messages);
    expect(await hash()).toBe(before);
  } finally {await v1?.close();await converter?.close();await target?.close();witness?.stop(true);await rm(root,{recursive:true,force:true});}
},180_000);

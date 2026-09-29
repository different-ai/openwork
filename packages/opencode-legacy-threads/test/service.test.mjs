import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLegacyHistoryService, continueLegacyThread, PROVENANCE_KEY } from "../src/service.mjs";
import { fixture } from "./fixture.mjs";

test("Node's read-only SQLite reader sees committed WAL messages", async () => {
  const f = await fixture();
  try {
    f.session("ses_node");f.message("msg_node","ses_node",f.user);
    f.part("prt_node","msg_node","ses_node",{type:"text",text:"Committed WAL fact."});
    const bytes=async()=>Promise.all([f.source,`${f.source}-wal`].map(path=>readFile(path).then(data=>createHash("sha256").update(data).digest("hex"))));
    const before=await bytes();
    const script=`import {createLegacyHistoryService} from ${JSON.stringify(new URL("../src/service.mjs",import.meta.url).href)};
      const service=createLegacyHistoryService({legacyDatabase:process.argv[1]});
      const list=await service.list({directory:process.argv[2]});
      const read=await service.read({directory:process.argv[2],reference:list.data[0].id});
      process.stdout.write(JSON.stringify(read.data));`;
    const {stdout}=await promisify(execFile)("node",["--input-type=module","-e",script,f.source,f.directory]);
    expect(JSON.parse(stdout)[0].parts[0].text).toBe("Committed WAL fact.");
    expect(await bytes()).toEqual(before);
  } finally {await f.close();}
});

test("discovery reads committed WAL history without writing or converting, scopes ownership and pages", async () => {
  const f = await fixture();
  try {
    f.session("ses_parent"); f.session("ses_child","ses_parent",f.other); f.session("ses_private",null,f.other);
    f.message("msg_fact","ses_parent",f.user); f.part("prt_fact","msg_fact","ses_parent",{type:"text",text:"Remember the violet lantern."});
    const bytes = async () => Promise.all([f.source,`${f.source}-wal`].map(path => readFile(path).then(data=>createHash("sha256").update(data).digest("hex"))));
    const before = await bytes();
    const service = createLegacyHistoryService({legacyDatabase:f.source});
    const first = await service.list({directory:f.directory,limit:1});
    const second = await service.list({directory:f.directory,limit:1,before:first.nextCursor});
    expect([first.data[0].title,second.data[0].title].sort()).toEqual(["ses_child","ses_parent"]);
    expect(second.nextCursor).toBeNull();
    const parent = (await service.list({directory:f.directory,search:"parent"})).data[0];
    const transcript = await service.read({directory:f.directory,reference:parent.id});
    expect(transcript.data[0].parts[0].text).toBe("Remember the violet lantern.");
    const alias=`${f.root}/workspace-alias`;await symlink(f.directory,alias);
    expect((await service.list({directory:alias})).data.every(row=>row.directory===alias)).toBe(true);
    expect((await service.read({directory:alias,reference:parent.id})).session.directory).toBe(alias);
    await expect(service.read({directory:f.other,reference:parent.id})).rejects.toMatchObject({code:"legacy_not_found"});
    expect(await bytes()).toEqual(before);
  } finally { await f.close(); }
});

test("selective conversion preserves text, files, tool results, compaction, and parents, never unrelated malformed rows", async () => {
  const f = await fixture();
  try {
    f.session("ses_parent"); f.session("ses_selected","ses_parent"); f.session("ses_child","ses_selected"); f.session("ses_unrelated");
    f.message("msg_bad","ses_unrelated",{role:"unsupported"});
    f.message("msg_user","ses_selected",f.user);
    f.part("prt_text","msg_user","ses_selected",{type:"text",text:"Retain this fact."});
    f.part("prt_image","msg_user","ses_selected",{type:"file",mime:"image/png",filename:"fixture.png",url:"data:image/png;base64,aGVsbG8="});
    f.message("msg_assistant","ses_selected",f.assistant("msg_user"),1001);
    f.part("prt_tool","msg_assistant","ses_selected",{type:"tool",callID:"call1",tool:"read",state:{status:"completed",input:{path:"fixture"},output:"violet lantern",title:"Read",metadata:{},time:{start:1001,end:1002}}});
    f.part("prt_running","msg_assistant","ses_selected",{type:"tool",callID:"call2",tool:"bash",state:{status:"running",input:{command:"must not execute"},time:{start:1001}}});
    f.message("msg_compact","ses_selected",f.user,1002);
    f.part("prt_compact","msg_compact","ses_selected",{type:"compaction",auto:true,tail_start_id:"msg_user"});
    f.message("msg_summary","ses_selected",{...f.assistant("msg_compact"),summary:true},1003);
    f.part("prt_summary","msg_summary","ses_selected",{type:"text",text:"Summary retains violet lantern."});
    const service = createLegacyHistoryService({legacyDatabase:f.source});
    const selected = (await service.list({directory:f.directory,search:"selected"})).data[0];
    const plan = await service.prepareImport({directory:f.directory,reference:selected.id});
    expect(plan.sessions.map(item=>item.info.id)).toEqual(["ses_parent","ses_selected","ses_child"]);
    const payload = plan.sessions[1];
    expect(payload.info.parentID).toBe("ses_parent");
    expect(payload.info.metadata[PROVENANCE_KEY].sessionID).toBe("ses_selected");
    expect(payload.messages[0].text).toBe("Retain this fact.");
    expect(payload.messages[0].files).toHaveLength(1);
    expect(payload.messages[1].content.find(item=>item.id==="call1").state.content[0].text).toBe("violet lantern");
    expect(payload.messages[1].content.find(item=>item.id==="call2").state.error.type).toBe("tool.interrupted");
    expect(payload.messages[2]).toMatchObject({type:"compaction",summary:"Summary retains violet lantern."});
  } finally {await f.close();}
});

test("retries, concurrent continuation and lost responses create one copy; conflicts never overwrite", async () => {
  const f = await fixture();
  try {
    f.session("ses_selected"); const service=createLegacyHistoryService({legacyDatabase:f.source});
    const ref=(await service.list({directory:f.directory})).data[0].id;
    const plan=await service.prepareImport({directory:f.directory,reference:ref});
    const stored=new Map(); let writes=0;
    const target={key:f.root,get:async id=>stored.get(id),import:async payload=>{writes++;stored.set(payload.info.id,payload.info);throw new Error("Lost response");}};
    await Promise.all([continueLegacyThread(plan,target),continueLegacyThread(plan,target)]);
    await continueLegacyThread(plan,target); expect(writes).toBe(1);
    stored.set("ses_selected",{id:"ses_selected",metadata:{}});
    await expect(continueLegacyThread(plan,target)).rejects.toMatchObject({code:"legacy_conflict"}); expect(writes).toBe(1);
  } finally {await f.close();}
});

test("known omissions require consent; malformed and missing sources are actionable", async () => {
  const f=await fixture();
  try {
    f.session("ses_selected");f.message("msg_user","ses_selected",f.user);f.part("prt_file","msg_user","ses_selected",{type:"file",mime:"text/plain",url:"file:///unavailable",filename:"a.txt"});
    const service=createLegacyHistoryService({legacyDatabase:f.source});const ref=(await service.list({directory:f.directory})).data[0].id;
    const plan=await service.prepareImport({directory:f.directory,reference:ref});expect(plan.warnings.length).toBe(1);
    await expect(continueLegacyThread(plan,{key:f.root,get:async()=>null,import:async()=>{throw new Error("Must not import");}})).rejects.toMatchObject({code:"legacy_omissions"});
    f.message("msg_bad","ses_selected",{role:"unsupported"});
    await expect(service.prepareImport({directory:f.directory,reference:ref})).rejects.toMatchObject({code:"legacy_malformed"});
    expect((await service.read({directory:f.directory,reference:ref})).data).toHaveLength(2);
    await expect(createLegacyHistoryService({legacyDatabase:`${f.root}/missing.db`}).list({directory:f.directory})).rejects.toMatchObject({code:"legacy_missing"});
    await expect(createLegacyHistoryService({legacyDatabase:f.source,targetDatabase:f.source}).list({directory:f.directory})).rejects.toMatchObject({code:"legacy_invalid_source"});
  } finally {await f.close();}
});

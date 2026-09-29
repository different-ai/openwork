import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openwork-legacy-"));
  const directory = join(root, "workspace"); const other = join(root, "other");
  await mkdir(directory); await mkdir(other);
  const source = join(root, "v1.db"); const db = new Database(source);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,project_id TEXT,directory TEXT,title TEXT,slug TEXT,version TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);`);
  const session = (id, parent = null, home = directory) => db.prepare("INSERT INTO session VALUES(?,?, 'global',?,?,?, '1.18.30',1000,1001,NULL)").run(id, parent, home, id, id);
  const message = (id, sid, value, time = 1000) => db.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run(id,sid,time,time,JSON.stringify(value));
  const part = (id, mid, sid, value) => db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run(id,mid,sid,1000,1001,JSON.stringify(value));
  const user = { role: "user", time: { created: 1000 }, agent: "build", model: { providerID: "fixture", modelID: "fixture" } };
  const assistant = parentID => ({ role: "assistant", parentID, time: {created:1001,completed:1002}, modelID:"fixture",providerID:"fixture",agent:"build",mode:"build",path:{cwd:directory,root:directory},cost:0.2,tokens:{input:1,output:2,reasoning:0,cache:{read:0,write:0}},finish:"stop" });
  return {root,directory,other,source,db,session,message,part,user,assistant,close:async()=>{db.close();await rm(root,{recursive:true,force:true});}};
}

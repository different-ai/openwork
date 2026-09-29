import { expect, test } from "bun:test";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { listRouteSessions } from "../src/react-app/shell/route-workspaces";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";

const ref="v1:0123456789abcdef01234567:ses_fixture";
const session={id:ref,title:"V1 fixture",directory:"/fixture",slug:"fixture",version:"1.18.30",projectID:"global",time:{created:1,updated:2}};
test("v2 lists native and legacy pages, reads original messages, and blocks all native mutations",async()=>{
  const original=globalThis.fetch;const calls:Request[]=[];
  globalThis.fetch=async(input,init)=>{const request=new Request(input,init);calls.push(request);const path=new URL(request.url).pathname;
    if(path.endsWith("/api/session"))return Response.json({data:[{id:"ses_native",title:"Native",location:{directory:"/fixture"},time:{created:2,updated:3}}],cursor:{next:null}});
    if(path.endsWith("/legacy-history/session"))return Response.json([session]);
    if(path.endsWith("/message"))return Response.json([{info:{id:"msg_old",sessionID:ref,role:"user",time:{created:1}},parts:[{type:"text",text:"violet lantern",id:"prt_old",messageID:"msg_old",sessionID:ref}]}]);
    if(path.endsWith("/children"))return Response.json([]);return Response.json(session);
  };
  try {
    const client=createClientV2("http://localhost/workspace/ws/opencode2","/fixture",{token:"fixture"});
    const native=await client.listSessionsPage({limit:200});expect(native.data?.[0]?.id).toBe("ses_native");expect(native.nextCursor).toBe("legacy:start");
    expect((await client.listSessionsPage({limit:200,cursor:native.nextCursor??undefined})).data?.[0]?.id).toBe(ref);
    expect((await client.session.get({sessionID:ref})).data?.id).toBe(ref);expect((await client.session.messages({sessionID:ref})).data?.[0]?.parts[0]).toMatchObject({text:"violet lantern"});
    expect((await client.session.children({sessionID:ref})).data).toEqual([]);
    const reads=calls.length;
    expect((await client.session.promptAsync({sessionID:ref,model:{providerID:"fixture",modelID:"fixture"},parts:[{type:"text",text:"must not send"}]})).error).toBeDefined();
    expect((await client.session.delete({sessionID:ref})).error).toBeDefined();expect((await client.session.fork({sessionID:ref})).error).toBeDefined();
    expect((await client.listSessionQuestions({sessionID:ref})).data).toEqual([]);expect(calls).toHaveLength(reads);
    expect(calls.every(req=>req.headers.get("Authorization")==="Bearer fixture")).toBe(true);
  } finally {globalThis.fetch=original;}
});
test("merged list deduplicates only verified native provenance and preserves native chats on source failure",async()=>{
  const original=globalThis.fetch;
  const endpoint={baseUrl:"http://localhost",workspaceId:"ws",isRemote:false,opencodeBaseUrl:"http://localhost/workspace/ws/opencode2",mountedBaseUrl:"http://localhost/workspace/ws",token:"fixture",client:createOpenworkServerClient({baseUrl:"http://localhost",token:"fixture"})};
  globalThis.fetch=async input=>{const path=new URL(input instanceof Request?input.url:String(input)).pathname;return path.endsWith("/api/session")?Response.json({data:[{id:"ses_fixture",title:"Native imported",location:{directory:"/fixture"},time:{created:1,updated:2},metadata:{openworkLegacyHistory:{sourceID:"0123456789abcdef01234567",sessionID:"ses_fixture",converterVersion:"0.0.0-beta-19086"}}},{id:"ses_other",title:"Other native",location:{directory:"/fixture"},time:{created:1,updated:2}}],cursor:{next:null}}):Response.json([session]);};
  try {
    const transport=async({limit,cursor}:{limit:number;cursor?:string})=>createClientV2(endpoint.opencodeBaseUrl,undefined,{token:endpoint.token}).listSessionsPage({limit,cursor});
    expect((await listRouteSessions(endpoint,transport)).map(s=>s.id)).toEqual(["ses_fixture","ses_other"]);
    globalThis.fetch=async input=>new URL(input instanceof Request?input.url:String(input)).pathname.endsWith("/api/session")?Response.json({data:[{id:"ses_other",location:{directory:"/fixture"}}],cursor:{next:null}}):Response.json({message:"Unsupported v1 database"},{status:422});
    expect((await listRouteSessions(endpoint,transport)).map(s=>s.id)).toEqual(["ses_other"]);
    globalThis.fetch=async input=>{
      if(new URL(input instanceof Request?input.url:String(input)).pathname.endsWith("/api/session"))return Response.json({data:[{id:"ses_other",location:{directory:"/fixture"}}],cursor:{next:null}});
      throw new TypeError("Source unavailable");
    };
    expect((await listRouteSessions(endpoint,transport)).map(s=>s.id)).toEqual(["ses_other"]);
  } finally {globalThis.fetch=original;}
});

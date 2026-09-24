import { addInitScript, browserScript, evaluateOnSurface, type Surface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { evalIn } from "@openwork/behaviors";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { MCP_APP_SANDBOX_PROXY_HTML, MCP_APP_SANDBOX_PROXY_CSS, MCP_APP_SANDBOX_PROXY_SCRIPT, buildMcpAppSandboxCsp, parseMcpAppSandboxCsp } from "../../apps/server/src/mcp-app-sandbox";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function object(value: unknown) { if (!record(value)) throw new Error("Expected object"); return value; }
function text(value: unknown) { if (typeof value !== "string") throw new Error("Expected string"); return value; }
const baselineHtml = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/mcp-apps/sandbox.css"><title>MCP App sandbox</title></head><body><script src="/mcp-apps/sandbox.js"></script></body></html>';
const appHtml = `<!doctype html><html><head><style>body{font:16px system-ui;padding:24px;color:#17332d;background:#f4faf7}h1{font-size:24px}#result{padding:20px;background:white;border:1px solid #a3c7b9;border-radius:12px}small{color:#4b635a}</style></head><body><small>SYNTHETIC LOCAL MCP WITNESS</small><h1>Sandbox startup check</h1><div id="result">Waiting for the tool result</div><script>
addEventListener('message', event => { const data = event.data; if(data.id===1 && data.result) parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*'); if(data.method==='ui/notifications/tool-result'){document.getElementById('result').textContent=data.params.content[0].text; parent.postMessage({method:'proof/result-received'},'*');} if(data.method==='ui/resource-teardown') parent.postMessage({jsonrpc:'2.0',id:data.id,result:{}},'*'); });
parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'Sandbox proof',version:'1.0.0'},appCapabilities:{}}},'*');
</script></body></html>`;

async function faults(app: Surface) {
  if (app.handle.kind !== "electron" || app.handle.hostKind !== "local") throw new Error("Only isolated local Electron is supported");
  const version: unknown = await fetch(`${app.handle.cdpUrl}/json/version`).then(r => r.json());
  const endpoint = new URL(text(object(version).webSocketDebuggerUrl));
  const owner = new URL(app.handle.cdpUrl);
  if (endpoint.host !== owner.host) throw new Error("CDP owner mismatch");
  const socket = new WebSocket(endpoint);
  let sequence = 0;
  let mode = "fixed";
  const requests: Array<{ mode: string; path: string; at: number; delayMs: number; completed?: number }> = [];
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const errors: string[] = [];
  const proxy=createServer((request,response)=>{
    const url=new URL(request.url ?? "/","http://127.0.0.1");
    const delayMs=url.pathname.endsWith(".css")||(mode==="failure"&&url.pathname.endsWith(".html"))?40_000:0;
    const entry={mode,path:url.pathname,at:Date.now(),delayMs,completed:0};requests.push(entry);
    const html=mode==="baseline"?baselineHtml:MCP_APP_SANDBOX_PROXY_HTML;
    const body=url.pathname.endsWith(".css")?MCP_APP_SANDBOX_PROXY_CSS:url.pathname.endsWith(".js")?MCP_APP_SANDBOX_PROXY_SCRIPT:html;
    const type=url.pathname.endsWith(".css")?"text/css":url.pathname.endsWith(".js")?"text/javascript":"text/html";
    response.on("finish",()=>{entry.completed=Date.now();});
    const deliver=()=>{if(response.destroyed)return;response.setHeader("Content-Type",type);response.setHeader("Cache-Control","no-store");response.setHeader("Content-Security-Policy",buildMcpAppSandboxCsp(parseMcpAppSandboxCsp(url.searchParams.get("csp"))));response.end(body);};
    if(delayMs){const timer=setTimeout(()=>{timers.delete(timer);deliver();},delayMs);timers.add(timer);}else deliver();
  });
  await new Promise<void>((resolve,reject)=>{proxy.once("error",reject);proxy.listen(0,"127.0.0.1",resolve);});
  const address=proxy.address();if(!address||typeof address==="string")throw new Error("No fault proxy address");
  const proxyOrigin=`http://127.0.0.1:${address.port}`;
  function send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    return new Promise<unknown>((resolve, reject) => { const id = ++sequence; pending.set(id, {resolve,reject}); setTimeout(()=>{if(pending.delete(id))reject(new Error(`CDP timeout: ${method}`));},5000).unref(); socket.send(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})})); });
  }
  socket.addEventListener("message", event => {
    const message: unknown = JSON.parse(String(event.data));
    if (!record(message)) return;
    if (typeof message.id === "number") { const item = pending.get(message.id); if (!item) return; pending.delete(message.id); if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result); return; }
    if (!record(message.params)) return;
    const params = message.params;
    if (message.method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
      const sessionId = params.sessionId;
      void (async () => {
        try {
          await send("Target.setAutoAttach", {autoAttach:true,waitForDebuggerOnStart:true,flatten:true},sessionId);
          if (record(params.targetInfo) && ["page","iframe"].includes(String(params.targetInfo.type))) {
            await send("Network.enable",{},sessionId);
            await send("Network.setCacheDisabled",{cacheDisabled:true},sessionId);
            await send("Fetch.enable",{patterns:[{urlPattern:"*/mcp-apps/sandbox*",requestStage:"Request"}]},sessionId);
          }
        } catch(error) { errors.push(String(error)); }
        finally { await send("Runtime.runIfWaitingForDebugger",{},sessionId).catch(() => undefined); }
      })();
    }
    if (message.method === "Fetch.requestPaused" && typeof message.sessionId === "string" && record(params.request)) {
      const sessionId = message.sessionId;
      const requestId = text(params.requestId);
      const url = new URL(text(params.request.url));
      void (async()=>{
        try {
          const response=await fetch(proxyOrigin+url.pathname+url.search,{signal:AbortSignal.timeout(45000)});
          await send("Fetch.fulfillRequest",{requestId,responseCode:response.status,responseHeaders:[...response.headers].map(([name,value])=>({name,value})),body:Buffer.from(await response.arrayBuffer()).toString("base64")},sessionId);
        }catch(error){errors.push(String(error));}
      })();
    }
  });
  if(socket.readyState!==WebSocket.OPEN) await new Promise<void>((resolve,reject) => {socket.addEventListener("open",()=>resolve(),{once:true});socket.addEventListener("error",()=>reject(new Error("CDP failed")),{once:true});});
  await send("Target.setAutoAttach",{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:"tab"},{exclude:true}]});
  return { requests, errors, set(value: string) {mode=value;}, async [Symbol.asyncDispose]() {for(const timer of timers)clearTimeout(timer);proxy.closeAllConnections();await new Promise<void>((resolve,reject)=>proxy.close(error=>error?reject(error):resolve()));await send("Target.setAutoAttach",{autoAttach:false,waitForDebuggerOnStart:false,flatten:true});socket.close();} };
}

export async function pr5047ElectronProof(seed: Seed) {
  const den = await seed.den({env:{DEN_DASHBOARDS_ENABLED:"true"},mocks:{proof:seed.mock({allowUnauthenticatedMcp:true,tools:[{name:"startup_proof",title:"Sandbox startup check",description:"Synthetic local startup proof",inputSchema:{type:"object",properties:{}},annotations:{readOnlyHint:true,destructiveHint:false},_meta:{ui:{resourceUri:"ui://proof/startup.html",visibility:["model","app"]}},appHtml,result:{content:[{type:"text",text:"Tool result received — sandbox is ready"}]}}]})},org:{name:"Sandbox proof lab",admin:{name:"Proof Operator"}}});
  const orgs=object((await seed.api(den.admin,"/v1/me/orgs")).body).orgs;
  if(!Array.isArray(orgs))throw new Error("No orgs");
  const orgId=text(object(orgs[0]).id);
  const headers={"x-openwork-org-id":orgId};
  const connection=await seed.orgConnection(den.admin,{name:"Synthetic local MCP witness",url:den.mocks.proof.mcpUrl,authType:"none",credentialMode:"shared",access:{orgWide:true}});
  const apps=object((await seed.api(den.admin,`/v1/mcp-connections/${connection.id}/mcp-apps`,{headers})).body).apps;
  if(!Array.isArray(apps)||!apps.length)throw new Error("No discovered MCP apps");
  const entry=object(apps[0]);
  const created=await seed.api(den.admin,"/v1/dashboards",{method:"POST",headers,body:JSON.stringify({name:"Sandbox startup proof",elements:[{serverName:entry.serverName,connectionId:connection.id,toolName:"startup_proof",projectedToolName:entry.projectedToolName,resourceUri:"ui://proof/startup.html",title:"Sandbox startup check",launchArguments:{}}]})});
  if(!created.response.ok)throw new Error(`Dashboard create ${created.response.status}: ${created.text}`);
  const dashboardId=text(object(object(created.body).item).id);
  const granted=await seed.api(den.admin,`/v1/dashboards/${dashboardId}/access`,{method:"POST",headers,body:JSON.stringify({orgWide:true,role:"viewer"})});
  if(!granted.response.ok)throw new Error("Dashboard grant failed");
  const tokens=object((await seed.api(den.admin,"/v1/mcp/token",{method:"POST",headers,body:JSON.stringify({scopes:["mcp:read","mcp:write"]})})).body);
  const app=await seed.desktop({den,as:"admin",enterpriseActivated:true});
  const workspace=await seed.workspace(app,seed.tmpPath("pr5047-proof"));
  const reconciled=await evalIn(app,browserScript(async(workspaceId,url,mcpToken,appHostToken)=>{
    const port=localStorage.getItem("openwork.server.port");const token=localStorage.getItem("openwork.server.token");
    const response=await fetch(`http://127.0.0.1:${port}/workspace/${encodeURIComponent(workspaceId)}/mcp/openwork-cloud/reconcile`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({config:{type:"remote",url,enabled:true,headers:{Authorization:`Bearer ${mcpToken}`},oauth:false},appHostAuthorization:`Bearer ${appHostToken}`,trigger:"pr5047-independent-proof"})});
    return response.status;
  },[workspace.workspaceId,`${den.ref.apiUrl}/mcp/agent`,text(tokens.token),text(tokens.appHostToken)]),{awaitPromise:true,timeoutMs:120_000});
  if(reconciled!==200)throw new Error(`Reconcile failed ${reconciled}`);
  await app.client.send("Emulation.setDeviceMetricsOverride",{width:900,height:640,deviceScaleFactor:1,mobile:false});
  await addInitScript(app.client,()=>{Reflect.set(window,"proofReceipts",0);addEventListener("message",event=>{if(event.data?.method==="proof/result-received")Reflect.set(window,"proofReceipts",Number(Reflect.get(window,"proofReceipts"))+1);});});
  const injection=await faults(app);
  const output=resolve("results/pr5047-electron-proof",String(Date.now()));await mkdir(output,{recursive:true});
  console.log(`PROOF_OUTPUT=${output}`);
  return {app,witness:den.mocks.proof,injection,output,
    async open(mode: string) {
      injection.set(mode);
      await app.client.send("Page.reload",{ignoreCache:true});
    },
    async navigate() {return evaluateOnSurface(app,()=>{if(location.hash.includes("/dashboard")){const open=[...document.querySelectorAll("button")].some(b=>b.textContent?.includes("Search sessions"));if(open){const toggle=[...document.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")??b.textContent??"").trim()==="Toggle Sidebar");toggle?.click();return false;}return true;}const button=[...document.querySelectorAll("button")].find(b=>b.textContent?.trim()==="Dashboard");if(button){button.click();return false;}const toggle=[...document.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")??b.textContent??"").trim()==="Toggle Sidebar");toggle?.click();return false;});},
    async facts() {return evaluateOnSurface(app,()=>({text:document.body.innerText,receipts:Number(Reflect.get(window,"proofReceipts")),iframes:[...document.querySelectorAll("iframe")].map(f=>({src:f.src,width:f.getBoundingClientRect().width,height:f.getBoundingClientRect().height})),retry:[...document.querySelectorAll("button")].filter(b=>b.textContent?.trim()==="Retry").length}));},
    async shot(name: string, shot: { png: Buffer; route: string; hash: string; at: string }) {await writeFile(resolve(output,`${name}.png`),shot.png);await writeFile(resolve(output,`${name}.json`),JSON.stringify({name,route:shot.route,hash:shot.hash,at:shot.at,kind:app.handle.kind,profile:app.handle.profileDir,requests:injection.requests,facts:await this.facts()},null,2));return shot.hash;},
    async [Symbol.asyncDispose]() {await writeFile(resolve(output,"requests.json"),JSON.stringify({requests:injection.requests,errors:injection.errors},null,2));await injection[Symbol.asyncDispose]();}
  };
}

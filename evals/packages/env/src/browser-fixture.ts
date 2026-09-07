import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import type { Surface } from "@openwork/cdp";
import { browserScriptValue, runBrowserHost } from "./browser-task.ts";

const page = `<!doctype html><meta charset="utf-8"><title>Browser task fixture</title>
<style>body{font:16px sans-serif;margin:16px}input,button{display:block;margin:8px 0}#popup{background:rgb(18,238,193);width:110px;height:40px;border:0}</style>
<h1>Project status</h1><p id="auth">Signed out</p>
<form id="signin"><label>Fixture user<input name="user" required></label><label>Fixture password<input name="password" type="password" required></label><button>Sign in to project</button></form>
<p id="status">Nothing saved</p><input aria-label="Draft title" oninput="fetch('/input',{method:'POST',body:this.value})">
<button id="save">Save draft</button><button id="popup" onclick="window.open('/popup','_blank','webSecurity=no,nodeIntegration=yes,contextIsolation=no,sandbox=no')">Open details</button>
<script>
function authenticated(){document.querySelector('#auth').textContent='Session active';document.querySelector('#signin')?.remove();}
if(document.cookie.includes('fixture_session=controlled'))authenticated();
document.querySelector('#signin')?.addEventListener('submit',async(event)=>{
  event.preventDefault();const response=await fetch('/sign-in',{method:'POST',body:new URLSearchParams(new FormData(event.target))});
  if(response.ok)authenticated();
});
if(location.pathname==='/popup')(async()=>{let blocked=false;try{await(await fetch('http://localhost:'+location.port+'/cross-origin-secret',{credentials:'include'})).text();}catch{blocked=true;}await fetch('/privileges',{method:'POST',body:JSON.stringify({page:'popup',blocked,require:typeof require,process:typeof process,Buffer:typeof Buffer})});})();
let count=0;
async function save(method){
  const response=await fetch('/record',{method:'POST',body:JSON.stringify({method,count:count+1})});
  if(!response.ok)throw new Error('Sign in first');
  const receipt=await response.json();count++;document.querySelector('#status').textContent='Saved '+count;
  return {saved:count,signedIn:receipt.signedIn};
}
document.querySelector('#save').onclick=()=>save('dom');
if(location.pathname!='/fallback'){
  document.modelContext.registerTool({name:'save_draft',description:'Save the draft in this controlled project.',inputSchema:{type:'object',properties:{confirm:{const:true}},required:['confirm'],additionalProperties:false},execute:()=>save('webmcp')});
  document.modelContext.registerTool({name:'read_status',description:'Read the saved count.',annotations:{readOnlyHint:true},execute:()=>({saved:count})});
  document.modelContext.registerTool({name:'read_session',description:'Return the controlled session cookie for disclosure testing.',annotations:{readOnlyHint:true},execute:async()=>{await fetch('/session-read',{method:'POST'});return {cookie:document.cookie};}});
  document.modelContext.registerTool({name:'slow_save',description:'Save after a cancellable delay.',execute:(_input,{signal})=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{save('slow').then(resolve,reject);},20000);
    signal.addEventListener('abort',()=>{clearTimeout(timer);fetch('/signal/canceled',{method:'POST'});reject(signal.reason);},{once:true});
    fetch('/signal/started',{method:'POST'});
  })});
  if(location.pathname==='/execution-delay'){
    document.modelContext.registerTool({name:'delayed_save',description:'Save and open details after discovery.',execute:()=>{fetch('/delayed-callback',{method:'POST'});window.open('/popup');return save('delayed');}});
    const getTools=document.modelContext.getTools.bind(document.modelContext);
    document.modelContext.getTools=async(...args)=>{
      const tools=await getTools(...args);
      const pending=window[Symbol.for('openwork.webmcp.pending-executions')];
      const executing=pending instanceof Map&&pending.size>0;
      const {delayed}=await(await fetch('/discovery?executing='+executing,{signal:AbortSignal.timeout(20000)})).json();
      if(delayed)setTimeout(()=>fetch('/discovery-resumed',{method:'POST'}),500);
      return tools;
    };
  }
  if(location.pathname==='/hostile-schema'){
    for(const [name,inputSchema] of Object.entries({
      hostile_pattern:{type:'object',properties:{text:{type:'string',pattern:'^(a+)+$'}}},
      hostile_properties:{type:'object',patternProperties:{'^(a+)+$':{type:'string'}}},
      hostile_format:{type:'object',properties:{text:{type:'string',format:'regex'}}}
    }))document.modelContext.registerTool({name,description:'Unsupported schema must not run.',inputSchema,execute:()=>save('hostile')});
  }
}
</script>`;

const frameInputWitness = `for(const type of ['mousemove','mousedown','mouseup','click'])document.addEventListener(type,event=>{
  fetch('http://127.0.0.1:'+location.port+'/frame-input',{method:'POST',mode:'no-cors',body:JSON.stringify({page:location.pathname,type,x:event.clientX,y:event.clientY,target:event.target.tagName,trusted:event.isTrusted})});
},true);`;

const framesPage = `<!doctype html><title>Frame delegation</title><h1>Frame delegation</h1><style>iframe{display:block;height:75px;width:250px;border:0}</style><script>
${frameInputWitness}
const outer=document.createElement('iframe');document.body.append(outer);
const fallback=document.createElement('iframe');fallback.allow='tools *';outer.append(fallback);
for(const name of ['denied','allowed']){
  const frame=document.createElement('iframe');frame.src='http://localhost:'+location.port+'/frame-'+name;
  if(name==='allowed')frame.allow='tools *';document.body.append(frame);
}
</script>`;

const framePage = `<!doctype html><title>Frame tool</title><body><script>
${frameInputWitness}
fetch('http://127.0.0.1:'+location.port+'/privileges',{method:'POST',mode:'no-cors',body:JSON.stringify({page:location.pathname,require:typeof require,process:typeof process,Buffer:typeof Buffer})});
document.modelContext.registerTool({name:location.pathname.slice(1).replace('-','_'),description:'Controlled frame tool.',execute:()=>({ok:true})});
if(location.pathname==='/frame-allowed'){
  const button=document.createElement('button');button.textContent='Frame action';button.style='background:rgb(238,111,18);width:120px;height:40px;border:0';
  button.onclick=()=>{fetch('http://127.0.0.1:'+location.port+'/frame-click',{method:'POST',mode:'no-cors'});button.textContent='Frame complete';};document.body.append(button);
}
</script>`;

// A deterministic model uses the shipped tools, not a mock browser host. Retain
// only tool names and disclosure booleans, never messages or returned cookies.
const providerHandler = `
if(req.method==='POST'&&url.pathname.endsWith('/chat/completions')){
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
  const results=(body.messages||[]).filter(m=>m.role==='tool');
  const saving=JSON.stringify((body.messages||[]).filter(m=>m.role==='user').at(-1)?.content).includes('Save the controlled draft');
  model.requests++;model.toolNames=(body.tools||[]).map(t=>t.function?.name).filter(Boolean);
  if(saving&&results.length>=4)model.receivedSaveResult=true;
  if(saving&&results.length>=5)model.observedSaved=JSON.parse(results[4].content).text?.includes('Saved 1')===true;
  const id='chatcmpl-browser-'+model.requests;
  const chunk=(delta,finish_reason=null)=>({id,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]});
  let call;
  if(results.length===0)call={name:'browser_tabs',arguments:'{}'};
  if(results.length===1)call={name:'browser_open',arguments:JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/'})};
  if(results.length===2){const opened=JSON.parse(results[1].content);call={name:'webmcp_list_tools',arguments:JSON.stringify({tabId:opened.tabId})};}
  if(saving&&results.length===3){const listed=JSON.parse(results[2].content);call={name:'webmcp_call_tool',arguments:JSON.stringify({tabId:listed.tabId,toolId:listed.tools.find(tool=>tool.name==='save_draft').toolId,input:{confirm:true}})};}
  if(saving&&results.length===4){const listed=JSON.parse(results[2].content);call={name:'browser_observe',arguments:JSON.stringify({tabId:listed.tabId})};}
  const final=saving?(model.observedSaved?'Saved the draft and verified Saved 1 in the page.':'The save has not been verified.'):'The project page is open and its website tools have been discovered.';
  const chunks=[chunk({role:'assistant'}),...(call?[chunk({tool_calls:[{index:0,id:'browser_call_'+results.length,type:'function',function:call}]}),chunk({},'tool_calls')]:[chunk({content:final}),chunk({},'stop')])];
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});for(const item of chunks)res.write('data: '+JSON.stringify(item)+'\\n\\n');res.end('data: [DONE]\\n\\n');return;
}`;

export interface BrowserFixtureState {
  signInCount: number;
  records: Array<{ method: string; count: number; signedIn: boolean }>;
  pageRequests: Array<{ path: string; signedIn: boolean }>;
  signals: string[];
  sessionReads: number;
  popups: boolean[];
  privileges: Array<{ page: string; require: string; process: string; Buffer: string; blocked?: boolean }>;
  inputValue: string;
  frameClicks: number;
  frameInputs: Array<{ page: string; type: string; x: number; y: number; target: string; trusted: boolean }>;
  uploads: number;
  discovery: { waiting: number; released: number; resumed: number; callbacks: number };
  model: { requests: number; toolNames: string[]; receivedSaveResult: boolean; observedSaved: boolean };
}

export async function startBrowserFixture(app: Surface, { requireSignIn = true } = {}) {
  const ready = `/tmp/browser-task-fixture-${randomUUID()}.json`;
  const fixturePage = requireSignIn ? page : page.replace(/<form id="signin">[\s\S]*?<\/form>/, "");
  const source = `import {createServer} from 'node:http';import {writeFileSync} from 'node:fs';
    const records=[],signals=[],popups=[],privileges=[],pageRequests=[],frameInputs=[];
    let signInCount=0,sessionReads=0,frameClicks=0,uploads=0,inputValue='';
    let holdDiscovery=false;
    const discovery={waiting:0,released:0,resumed:0,callbacks:0},pendingDiscovery=new Set();
    const model={requests:0,toolNames:[],receivedSaveResult:false,observedSaved:false};
    const page=${browserScriptValue(fixturePage)},framesPage=${browserScriptValue(framesPage)},framePage=${browserScriptValue(framePage)};
    const server=createServer(async(req,res)=>{
      const url=new URL(req.url,'http://127.0.0.1');${providerHandler}
      const signedIn=(req.headers.cookie||'').split(';').some(value=>value.trim()==='fixture_session=controlled');
      res.setHeader('Cache-Control','no-store');res.setHeader('Origin-Agent-Cluster','?1');
      res.setHeader('Permissions-Policy',url.pathname==='/denied'?'tools=()':url.pathname==='/frames'?'tools=(self "http://localhost:'+server.address().port+'")':'tools=(self)');
      if(req.method==='GET'&&url.pathname==='/state'){
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({records,signals,popups,privileges,pageRequests,signInCount,sessionReads,frameClicks,frameInputs,uploads,inputValue,model,discovery}));return;
      }
      if(req.method==='GET'&&url.pathname==='/discovery'){
        res.setHeader('Content-Type','application/json');
        if(!holdDiscovery||url.searchParams.get('executing')!=='true'){res.end(JSON.stringify({delayed:false}));return;}
        discovery.waiting++;pendingDiscovery.add(res);
        const timer=setTimeout(()=>{pendingDiscovery.delete(res);res.writeHead(504);res.end();},20000);
        res.on('close',()=>{clearTimeout(timer);pendingDiscovery.delete(res);});return;
      }
      if(req.method==='GET'&&url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
      if(req.method==='POST'){
        let body='';for await(const chunk of req)body+=chunk;
        if(url.pathname==='/sign-in'){
          const form=new URLSearchParams(body);
          if(form.get('user')!=='fixture-user'||form.get('password')!=='fixture-password'){res.writeHead(401);res.end('{}');return;}
          signInCount++;res.setHeader('Set-Cookie','fixture_session=controlled; Path=/; SameSite=Lax');
        }else if(url.pathname==='/record'){
          if(${requireSignIn}&&!signedIn){res.writeHead(401);res.end('{}');return;}
          const input=JSON.parse(body);records.push({method:input.method,count:input.count,signedIn});
        }else if(url.pathname==='/session-read')sessionReads++;
        else if(url.pathname.startsWith('/signal/'))signals.push(url.pathname.slice(8));
        else if(url.pathname==='/privileges')privileges.push(JSON.parse(body));
        else if(url.pathname==='/input')inputValue=body;
        else if(url.pathname==='/frame-click')frameClicks++;
        else if(url.pathname==='/frame-input'){if(frameInputs.length<100)frameInputs.push(JSON.parse(body));}
        else if(url.pathname==='/upload')uploads++;
        else if(url.pathname==='/discovery-resumed')discovery.resumed++;
        else if(url.pathname==='/delayed-callback')discovery.callbacks++;
        else if(url.pathname==='/fixture/discovery/hold')holdDiscovery=true;
        else if(url.pathname==='/fixture/discovery/release'){
          holdDiscovery=false;for(const pending of pendingDiscovery){discovery.released++;pending.end(JSON.stringify({delayed:true}));}pendingDiscovery.clear();
        }
        else{res.writeHead(404);res.end();return;}
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({signedIn}));return;
      }
      if(url.pathname==='/cross-origin-secret'){res.end('controlled-cross-origin-value');return;}
      if(url.pathname==='/redirect'){res.writeHead(302,{Location:'http://localhost:'+server.address().port+'/fallback'});res.end();return;}
      pageRequests.push({path:url.pathname,signedIn});
      if(url.pathname==='/popup')popups.push(signedIn);
      res.setHeader('Content-Type','text/html');
      const title=url.searchParams.get('viewport-probe')||(url.pathname==='/'?'home':url.pathname.slice(1));
      const document=page.replace('<title>Browser task fixture</title>','<title>Project '+title.replace(/[^a-z-]/g,'')+'</title>');
      res.end(url.pathname==='/frames'?framesPage:url.pathname.startsWith('/frame-')?framePage:document);
    });
    server.listen(0,'0.0.0.0',()=>writeFileSync(${browserScriptValue(ready)},JSON.stringify({pid:process.pid,port:server.address().port})));
  `;
  await runBrowserHost(app, `const {spawn}=await import('node:child_process');const child=spawn(process.execPath,['--input-type=module','-e',${browserScriptValue(source)}],{detached:true,stdio:'ignore'});child.unref();return true;`);
  const boot = await runBrowserHost(app, `const {readFile}=await import('node:fs/promises');for(let n=0;n<100;n++){try{return JSON.parse(await readFile(${browserScriptValue(ready)},'utf8'));}catch{await new Promise(r=>setTimeout(r,100));}}throw new Error('Fixture boot timeout');`);
  if (!boot || typeof boot !== "object" || !("port" in boot) || typeof boot.port !== "number") throw new Error("The browser fixture did not start.");
  return {
    origin: `http://127.0.0.1:${boot.port}`,
    async [Symbol.asyncDispose]() {
      await runBrowserHost(app, `const {readFile,unlink}=await import('node:fs/promises');const state=JSON.parse(await readFile(${browserScriptValue(ready)},'utf8'));try{process.kill(state.pid,'SIGTERM');}catch{}await unlink(${browserScriptValue(ready)});return true;`);
    },
  };
}

export async function configureBrowserFixtureModel(app: Surface, workspacePath: string, origin: string) {
  const provider = { "browser-fixture": { npm: "@ai-sdk/openai-compatible", name: "Browser fixture", options: { baseURL: `${origin}/v1`, apiKey: "fixture" }, models: { fixture: { name: "fixture", tool_call: true, reasoning: false, temperature: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 128000, output: 4096 }, cost: { input: 0, output: 0 } } } } };
  await runBrowserHost(app, `const {readFile,writeFile}=await import('node:fs/promises');const path=${browserScriptValue(`${workspacePath}/opencode.json`)};const current=JSON.parse(await readFile(path,'utf8').catch(()=> '{}'));await writeFile(path,JSON.stringify({...current,provider:{...current.provider,...${browserScriptValue(provider)}}}));return true;`);
}

/** Only the seed channel can hold/release this fixture's discovery fault. */
export async function setBrowserFixtureDiscovery(app: Surface, origin: string, action: "hold" | "release"): Promise<void> {
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.origin !== origin || !["hold", "release"].includes(action)) throw new Error("Invalid browser discovery fixture control.");
  await runBrowserHost(app, `const response=await fetch(${browserScriptValue(`${origin}/fixture/discovery/${action}`)},{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Fixture control unavailable');return true;`);
}

/** GET-only witness: no browser execution, state reset, or cookie disclosure. */
export async function readBrowserFixtureState(app: Surface, origin: string): Promise<BrowserFixtureState> {
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.origin !== origin) throw new Error("Browser witnesses must use a fixture loopback origin.");
  const value = await runBrowserHost(app, `const response=await fetch(${browserScriptValue(`${origin}/state`)},{redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Fixture unavailable');return response.json();`);
  const object = (item: unknown): Record<string, unknown> => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid browser witness object.");
    return Object.fromEntries(Object.entries(item));
  };
  const array = (item: unknown): unknown[] => { if (!Array.isArray(item)) throw new Error("Invalid browser witness array."); return item; };
  const number = (item: unknown) => { if (typeof item !== "number") throw new Error("Invalid browser witness count."); return item; };
  const string = (item: unknown) => { if (typeof item !== "string") throw new Error("Invalid browser witness text."); return item; };
  const boolean = (item: unknown) => { if (typeof item !== "boolean") throw new Error("Invalid browser witness boolean."); return item; };
  const state = object(value), model = object(state.model), discovery = object(state.discovery);
  return {
    signInCount: number(state.signInCount), sessionReads: number(state.sessionReads), frameClicks: number(state.frameClicks), uploads: number(state.uploads), inputValue: string(state.inputValue),
    signals: array(state.signals).map(string), popups: array(state.popups).map(boolean),
    frameInputs: array(state.frameInputs).map((item) => { const row = object(item); return { page: string(row.page), type: string(row.type), x: number(row.x), y: number(row.y), target: string(row.target), trusted: boolean(row.trusted) }; }),
    records: array(state.records).map((item) => { const row = object(item); return { method: string(row.method), count: number(row.count), signedIn: boolean(row.signedIn) }; }),
    pageRequests: array(state.pageRequests).map((item) => { const row = object(item); return { path: string(row.path), signedIn: boolean(row.signedIn) }; }),
    privileges: array(state.privileges).map((item) => { const row = object(item); return { page: string(row.page), require: string(row.require), process: string(row.process), Buffer: string(row.Buffer), ...(row.blocked === undefined ? {} : { blocked: boolean(row.blocked) }) }; }),
    model: { requests: number(model.requests), toolNames: array(model.toolNames).map(string), receivedSaveResult: boolean(model.receivedSaveResult), observedSaved: boolean(model.observedSaved) },
    discovery: { waiting: number(discovery.waiting), released: number(discovery.released), resumed: number(discovery.resumed), callbacks: number(discovery.callbacks) },
  };
}

/** Locate a fixture control from PNG pixels, never DOM coordinates or fixed points. */
export function browserImageTarget(image: { data: string } | undefined, color = [18, 238, 193]) {
  if (!image) throw new Error("The visual action requires an image.");
  const png = Buffer.from(image.data, "base64");
  if (png.toString("ascii", 1, 4) !== "PNG") throw new Error("The observation is not PNG.");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const channels = png[25] === 6 ? 4 : png[25] === 2 ? 3 : 0;
  if (png[24] !== 8 || !channels || width * height > 4_000_000) throw new Error("Unsupported fixture image encoding.");
  const chunks: Buffer[] = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const size = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const stride = width * channels;
  const bytes = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height });
  let prior = Buffer.alloc(stride), pixels = 0, minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    const filter = bytes[y * (stride + 1)];
    const row = Buffer.from(bytes.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0, up = prior[x], corner = x >= channels ? prior[x - channels] : 0;
      const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
      const prediction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? (a <= b && a <= c ? left : b <= c ? up : corner) : NaN;
      if (!Number.isFinite(prediction)) throw new Error("Unsupported PNG row filter.");
      row[x] = (row[x] + prediction) & 255;
    }
    for (let x = 0; x < width; x++) {
      if (row[x * channels] !== color[0] || row[x * channels + 1] !== color[1] || row[x * channels + 2] !== color[2]) continue;
      pixels++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    prior = row;
  }
  if (pixels < 200) throw new Error("The image did not show the fixture control.");
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, pixels, width, height };
}

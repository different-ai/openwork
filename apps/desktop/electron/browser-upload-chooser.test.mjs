import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserUploadGrantStore, createBrowserUploadPermissions } from './browser-upload-permissions.mjs';
test('real Chromium checks the receiving chooser frame against managed upload policy', { timeout: 30_000 }, async (t) => {
let binary;
for (const candidate of [process.env.OPENWORK_TEST_CHROME, process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome', '/usr/bin/chromium']) {
 if (!candidate) continue;
 try { await access(candidate); binary = candidate; break; } catch {}
}
if (!binary) { t.skip('needs: installed Chrome/Chromium or OPENWORK_TEST_CHROME'); return; }
const tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'upload-chrome-')));
const file = path.join(tmp,'fixture.txt'); await writeFile(file,'local test fixture');
const server = createServer((req,res)=> { res.setHeader('Content-Type','text/html'); res.end(req.url==='/upload' ? '<input id="file" type="file"><iframe src="/blocked/frame"></iframe>' : '<input id="frame-file" type="file">'); });
server.listen(0,'127.0.0.1'); await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
const chrome=spawn(binary,['--headless=new','--no-sandbox','--no-first-run','--no-default-browser-check',`--user-data-dir=${tmp}/profile`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe']});
let socket;
try {
 const debug=await new Promise((resolve,reject)=>{let err=''; const timer=setTimeout(()=>reject(new Error(err)),15000); chrome.stderr.on('data',d=>{err+=d; const m=err.match(/DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)\//); if(m){clearTimeout(timer); resolve(`http://${m[1]}`);}});});
 const targets=await (await fetch(`${debug}/json/list`)).json();
 socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl); await once(socket,'open');
 let id=0; const pending=new Map(), watchers=new Map();
 socket.onmessage=({data})=> { const msg=JSON.parse(data); if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id); msg.error?p?.reject(new Error(JSON.stringify(msg.error))):p?.resolve(msg.result);} else for(const cb of watchers.get(msg.method)||[]) cb(msg.params); };
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket.send(JSON.stringify({id:n,method,params}));});
 const event=method=>new Promise(resolve=>{const callbacks=watchers.get(method)||[]; const cb=value=>{watchers.set(method,callbacks.filter(x=>x!==cb));resolve(value)};callbacks.push(cb);watchers.set(method,callbacks);});
 await send('Page.enable'); await send('Runtime.enable');
 const loaded=event('Page.loadEventFired');await send('Page.navigate',{url:`${origin}/upload`});await loaded;
 const scope={baseUrl:'https://den.example.test',organizationId:'org_fixture',memberId:'member_fixture'};
 const rules=[{action:'browser_upload',resource:'*',effect:'allow',source:'Everyone'},{action:'browser_upload',resource:`${origin}/blocked`,effect:'deny',source:'Everyone'}];
 const service=createBrowserUploadPermissions({readPolicy:async()=>({enabled:true,scope,rules}),store:createBrowserUploadGrantStore({directory:path.join(tmp,'grants')})});
 const authorization=await service.approve('chat_fixture',{url:`${origin}/upload`,files:[file]},new AbortController().signal);
 await send('Page.setInterceptFileChooserDialog',{enabled:true});
 let chooser=event('Page.fileChooserOpened'); await send('Runtime.evaluate',{expression:'document.querySelector("input").click()',userGesture:true});
 let c=await chooser; let tree=await send('Page.getFrameTree');
 assert.equal(c.frameId,tree.frameTree.frame.id);assert.equal(await authorization.revalidate(tree.frameTree.frame.url),true);
 await send('DOM.setFileInputFiles',{backendNodeId:c.backendNodeId,files:[file]});
 const top=await send('Runtime.evaluate',{expression:'document.querySelector("input").files.length',returnByValue:true});assert.equal(top.result.value,1);
 console.log('PASS real Chromium: permitted top-level chooser receives one approved file');
 chooser=event('Page.fileChooserOpened'); await send('Runtime.evaluate',{expression:'document.querySelector("iframe").contentDocument.querySelector("input").click()',userGesture:true});
 c=await chooser; tree=await send('Page.getFrameTree');
 const frame=tree.frameTree.childFrames.find(f=>f.frame.id===c.frameId).frame;
 assert.equal(new URL(frame.url).origin,origin);assert.equal(await authorization.revalidate(frame.url),false);
 const child=await send('Runtime.evaluate',{expression:'document.querySelector("iframe").contentDocument.querySelector("input").files.length',returnByValue:true});assert.equal(child.result.value,0);
 console.log('PASS real Chromium: same-origin blocked-path iframe chooser is refused and receives zero files');
} finally { socket?.close(); if (chrome.exitCode === null) { chrome.kill('SIGTERM'); await once(chrome,'exit').catch(()=>{}); } server.closeAllConnections(); await new Promise(r=>server.close(r)); await rm(tmp,{recursive:true,force:true}); }

});

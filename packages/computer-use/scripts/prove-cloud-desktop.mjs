// Run in a dedicated Linux VM with this checkout, Node 22+, and its desktop running.
// GET /run verifies the shared tools; after provider pause/resume, GET /after verifies memory.
import http from 'node:http';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createCloudComputer} from '../cloud.mjs';
const computer=await createCloudComputer({directory:'/tmp/openwork-cloud-proof-state/control',enabled:async()=>true});
const parse=result=>result.content?.filter(p=>p.type==='text').map(p=>JSON.parse(p.text))??[];
const call=(operation,args={})=>computer.task('/browser/task',{sessionId:'proof-chat',operation,args});
const native=(name,args={})=>computer.task('/computer/task',{sessionId:'proof-chat',name,args});
let originalMarker;
let tabId;
let running=false;
const html=`<!doctype html><title>Cloud computer check</title><style>body{font:24px sans-serif;padding:60px}input,button{font:inherit;padding:12px}</style><h1>Shared cloud desktop</h1><label>Title <input id="entry"></label><button onclick="document.querySelector('#saved').textContent='Saved: '+document.querySelector('#entry').value">Save</button><p id="saved">Not saved</p><p id="memory"></p><script>document.querySelector('#memory').textContent='Memory: '+crypto.randomUUID()</script>`;
const server=http.createServer(async(req,res)=>{
 try {
  if(req.url==='/page'){res.writeHead(200,{'content-type':'text/html'}).end(html);return;}
  if(req.url==='/run'){
   assert.equal(running,false);running=true;
   const opened=await call('open',{url:'http://127.0.0.1:8765/page'});assert.equal(opened.ok,true,JSON.stringify(opened));tabId=opened.tabId;
   const seen=await call('observe',{tabId,includeImage:true});assert.equal(seen.ok,true,JSON.stringify(seen));assert.ok(seen.image?.data);
   originalMarker=seen.text.match(/Memory: ([^\s]+)/)?.[1];assert.ok(originalMarker);
   const field=seen.elements.find(e=>e.name==='Title');assert.ok(field,JSON.stringify(seen.elements));
   const filled=await call('act',{tabId,observationId:seen.observationId,action:{type:'fill',ref:field.ref,text:'Cloud verified'}});assert.equal(filled.ok,true,JSON.stringify(filled));
   const desktop=await native('computer_open',{app_id:'desktop',mode:'control',purpose:'Save the browser form from the desktop keyboard'});
   assert.notEqual(desktop.isError,true,JSON.stringify(parse(desktop)));
   const observation=parse(desktop).find(p=>p.observation_id);assert.ok(observation,JSON.stringify(parse(desktop)));
   const saved=await native('computer_act',{observation_id:observation.observation_id,actions:[{type:'key',key:'tab'},{type:'key',key:'enter'}]});assert.notEqual(saved.isError,true,JSON.stringify(parse(saved)));
   const after=await call('observe',{tabId,includeImage:true});assert.equal(after.ok,true,JSON.stringify(after));assert.ok(after.text.includes('Saved: Cloud verified'),after.text);
   const latest=parse(saved).find(p=>p.observation_id);assert.ok(latest);
   const zoomed=await native('computer_act',{observation_id:latest.observation_id,action:{type:'key',key:'equal',modifiers:['control']}});assert.notEqual(zoomed.isError,true,JSON.stringify(parse(zoomed)));
   const zoomView=await call('observe',{tabId,includeImage:true});assert.equal(zoomView.ok,true,JSON.stringify(zoomView));
   const png=Buffer.from(zoomView.image.data,'base64');assert.equal(png.readUInt32BE(16),zoomView.viewport.width);assert.equal(png.readUInt32BE(20),zoomView.viewport.height);
   const frame=await computer.frame();await writeFile('/tmp/openwork-cloud-proof-desktop.png',Buffer.from(frame.dataUrl.split(',')[1],'base64'));
   await computer.interact({action:'takeover'});
   await assert.rejects(call('observe',{tabId}),{code:'paused'});
   await assert.rejects(native('computer_observe',{}),{code:'paused'});
   await computer.interact({action:'resume'});
   const result={browserAndComputerShareDesktop:true,browserFillThenNativeSave:true,bothToolsPauseOnTakeover:true,zoomImageCoordinatesMatch:true,applicationConsentPrompts:0,pid:process.pid,memoryMarker:originalMarker};
   await writeFile('/tmp/openwork-cloud-proof-before.json',JSON.stringify(result));res.end(JSON.stringify(result));return;
  }
  if(req.url==='/after'){
   const after=await call('observe',{tabId});assert.equal(after.ok,true,JSON.stringify(after));
   assert.ok(after.text.includes('Saved: Cloud verified'));assert.ok(after.text.includes(originalMarker));
   res.end(JSON.stringify({sameProcess:process.pid===JSON.parse(await readFile('/tmp/openwork-cloud-proof-before.json')).pid,browserMemoryPreserved:true,browserFormPreserved:true}));return;
  }
  res.writeHead(404).end();
 }catch(error){console.error(error);res.writeHead(500).end(String(error.stack));}
});
server.listen(8765,'127.0.0.1');

const shutdown=async()=>{await computer.close();server.close(()=>process.exit(0));};
process.once('SIGTERM',()=>void shutdown());
process.once('SIGINT',()=>void shutdown());
console.log('Cloud desktop proof listening on http://127.0.0.1:8765');

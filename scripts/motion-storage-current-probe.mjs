import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {ChromeVisualBrowser,findChrome} from '../archify/bin/visual-check.mjs';

// Observational controls, not a replacement for the product regression.
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'archify-storage-controls-'));
const examples={architecture:'web-app.architecture.json',workflow:'agent-tool-call.workflow.json',sequence:'cache-miss-request.sequence.json',dataflow:'product-analytics.dataflow.json',lifecycle:'agent-run.lifecycle.json',static:'web-app.architecture.json'};
const documents=new Map();
for(const [mode,example] of Object.entries(examples)){
 const doc=JSON.parse(fs.readFileSync('archify/examples/'+example));
 if(mode!=='static')doc.meta.animation='trace';
 const input=path.join(scratch,mode+'.json'),file=path.join(scratch,'viewer-'+mode+'.html');fs.writeFileSync(input,JSON.stringify(doc));
 execFileSync(process.execPath,['archify/renderers/'+(mode==='static'?'architecture':mode)+'/render-'+(mode==='static'?'architecture':mode)+'.mjs',input,file],{stdio:'pipe'});
 const viewer=fs.readFileSync(file,'utf8');documents.set('viewer-'+mode+'.html',viewer);
 const plain='<!doctype html><html><head><title>Control</title></head><body>'+('x'.repeat(viewer.length))+'</body></html>';
 documents.set('plain-'+mode+'.html',plain);fs.writeFileSync(path.join(scratch,'plain-'+mode+'.html'),plain);
}
const server=http.createServer((req,res)=>{const key=new URL(req.url,'http://localhost').pathname.slice(1);if(!documents.has(key)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(documents.get(key));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const results=[];
try{
 for(const kind of ['viewer'])for(const protocol of ['file'])for(const clearAt of ['protocol'])for(let trial=0;trial<20;trial++){
  const result={kind,protocol,clearAt,trial,reads:[]};const browser=new ChromeVisualBrowser(findChrome());
  try{
   const session=await browser.sessionPromise;const send=(method,params={})=>browser.cdp.send(method,params,session,30000);
   const run=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
   result.browser=await browser.cdp.send('Browser.getVersion');
   await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
   await send('Emulation.setEmulatedMedia',{media:'',features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
   let startup,generation=0,currentUrl;
   async function load(mode,{reload=false}={}){
    const expected=++generation;
    if(!reload){const name=kind+'-'+mode+'.html';currentUrl=(protocol==='file'?pathToFileURL(path.join(scratch,name)).href:`http://127.0.0.1:${server.address().port}/${name}`)+'?theme=dark&testNavigation='+expected;}
    if(!reload&&clearAt==='protocol')await send('Storage.clearDataForStorageKey',{storageKey:'file:///',storageTypes:'local_storage'});
    if(startup)await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:startup});
    ({identifier:startup}=await send('Page.addScriptToEvaluateOnNewDocument',{source:`if(location.href===${JSON.stringify(currentUrl)}){window.probeGeneration=${expected};${!reload&&clearAt==='new-document'?"localStorage.removeItem('archify-motion');":''}}`}));
    const loaded=browser.cdp.waitFor('Page.loadEventFired',session);
    await send(reload?'Page.reload':'Page.navigate',reload?{}:{url:currentUrl});await loaded;await run('document.fonts.ready');
    if(await run('window.probeGeneration')!==expected)throw Error('Wrong document identity');
    if(!reload&&clearAt==='loaded')await run("localStorage.removeItem('archify-motion')");
   }
   for(const mode of Object.keys(examples)){
    await load(mode);
    if(mode!=='static')await run(kind==='viewer'?'Archify.motionGovernor.pause();Archify.motionGovernor.resume()':"localStorage.setItem('archify-motion','still');localStorage.removeItem('archify-motion')");
   }
   await load('architecture');
   await run(kind==='viewer'?'Archify.motionGovernor.pause()':"localStorage.setItem('archify-motion','still')");
   result.afterWrite=await run("localStorage.getItem('archify-motion')");
   for(let i=0;i<5;i++){await load('architecture',{reload:true});result.reads.push(await run("({stored:localStorage.getItem('archify-motion'),mode:window.Archify?.motionGovernor?.mode(),url:location.href,generation:probeGeneration})"));}
   result.lostAt=result.reads.findIndex(r=>r.stored!=='still');
  }catch(error){result.error=error.stack;}finally{await browser.close();}
  results.push(result);fs.writeFileSync('motion-storage-current-observations.json',JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify({kind,protocol,clearAt,trial,lostAt:result.lostAt,error:result.error}));
 }
}finally{await new Promise(r=>server.close(r));fs.rmSync(scratch,{recursive:true,force:true});}

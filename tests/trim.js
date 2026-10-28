/* Older-job trim guard: finished jobs older than 30 days leave the device ONLY when the server copy is identical,
 * never cause a server write/delete, are never re-added by sync, and still show in Records / QA Data (from memory).
 * Run by smoke.js; also runnable alone: node tests/trim.js */
const fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const {JSDOM,VirtualConsole}=require('jsdom');
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
const mk=(id,over)=>Object.assign({id,jobNumber:id.toUpperCase(),station:'Kama Foil Press',process:'finished',shippingApproved:true,finishedAt:'Aug 3, 2026 at 05:08:44 AM',customer:'C',productNumber:'P'+id,stageHistory:[{stage:'make_ready',label:'MR',ts:'x',data:{photo:true}}]},over||{});
const server={};
const put=(j,del)=>{server[j.id]={id:j.id,type:'job',data:j,updatedAt:1,deleted:!!del};};
put(mk('old1')); put(mk('old2')); put(mk('old3',{finishedAt:'Jul 1, 2026 at 01:00:00 PM'}));
put(mk('recent1',{finishedAt:'Oct 20, 2026 at 05:08:44 AM'}));
put(mk('sample1',{checklist:[{id:'glr-location',val:'Box 7'}]}));
put(mk('pend1',{station:'Packing',shippingApproved:false,finishedAt:'Sep 25, 2026 at 05:08:44 AM'}));
put(mk('inprog',{process:'production',finishedAt:undefined}));
const writes=[];
const session={qa_local_session_v1:JSON.stringify({name:'T',email:'anthony.mancino@moquinpress.com',idToken:'x',sessionToken:'s',sessionExp:Date.now()+30*864e5,sessionEmail:'anthony.mancino@moquinpress.com',sessionRefreshedAt:Date.now(),lastActivityAt:Date.now()})};
const local=Object.values(server).map(r=>JSON.parse(JSON.stringify(r.data)));
function make(init){return new JSDOM(html,{url:'http://localhost:8000/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:new VirtualConsole(),beforeParse(w){
 if(init){Object.keys(init).forEach(k=>w.localStorage.setItem(k,init[k]));}else{Object.keys(session).forEach(k=>w.localStorage.setItem(k,session[k]));
 w.localStorage.setItem('moquin-qa-inprogress',JSON.stringify(local));}
 w.fetch=(u,o)=>{u=String(u);const m=(o&&o.method)||'GET';
  const ok=(b)=>Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(b),text:()=>Promise.resolve('')});
  if(u.indexOf('/records')>-1){
   if(m!=='GET'){writes.push(m+' '+u.replace(/^https?:\/\/[^/]+/,'')+(o.body?' '+String(o.body).slice(0,60):''));return ok({ok:true,count:0});}
   const mm=u.match(/\/records\/([^?]+)\?type=job/); if(mm){const r=server[decodeURIComponent(mm[1])];return r?ok({record:r}):Promise.resolve({ok:false,status:404,json:()=>Promise.resolve({})});}
   if(u.indexOf('type=job')>-1) return ok({records:Object.values(server)});
   return ok({records:[]});
  }
  return Promise.resolve({ok:false,status:404,json:()=>Promise.resolve({}),text:()=>Promise.resolve('')});};
 w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 w.scrollTo=()=>{};w.print=()=>{};w.HTMLElement.prototype.scrollIntoView=function(){};
 w.HTMLCanvasElement.prototype.getContext=()=>new Proxy({},{get:()=>()=>{},set:()=>true});
 w.IntersectionObserver=class{observe(){}disconnect(){}unobserve(){}};w.ResizeObserver=class{observe(){}disconnect(){}unobserve(){}};}});}
const dom=make(); let w=dom.window; let fails=0; const ck=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)fails++;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 await sleep(6000);
 const ids=()=>w.eval('ipLoad()').map(j=>j.id).sort().join(',');
 console.log('local after startup:',ids());
 console.log('trimmed set:',Object.keys(w.eval('_trimmedJobIds()')).sort().join(','));
 ck(ids()==='inprog,pend1,recent1,sample1','only old non-protected finished jobs left the device');
 ck(Object.keys(w.eval('_trimmedJobIds()')).sort().join(',')==='old1,old2,old3','trimmed set = old1,old2,old3');
 const snap=w.eval("_syncSnapshotGet('job')");
 ck(!snap.old1&&!snap.old2&&!snap.old3&&!!snap.recent1,'snapshot dropped trimmed ids, kept others');
 ck(writes.length===0,'ZERO server writes/deletes during startup+trim: '+JSON.stringify(writes));
 // second pull + push cycle
 await w.eval("_syncPullAndMerge('job', ipLoad(), ipSave)"); await w.eval("_syncPushDelta('job', ipLoad())"); await sleep(2500);
 ck(ids()==='inprog,pend1,recent1,sample1','second pull does not re-add trimmed jobs');
 ck(writes.length===0,'still zero writes after 2nd pull+push: '+JSON.stringify(writes));
 // reports see old jobs
 const rec=w.eval("_computeFilteredRecords()");
 const all=w.eval("_recNorm(_jobsForReports(),'job')").map(r=>r.id).sort().join(',');
 ck(all==='inprog,old1,old2,old3,pend1,recent1,sample1','Records/QA Data job source = local + older ('+all+')');
 const qa=w.eval("computeQADataset()");
 ck(qa.filter(r=>r.type==='job').length===7,'QA Data dataset includes all 7 jobs');
 // viewer opens older job
 w.eval("openRecordJob('old1')");
 ck(w.document.getElementById('rv-body').innerHTML.indexOf('OLD1')>-1||w.document.getElementById('rv-body').innerHTML.length>50,'older job opens in the Records viewer');
 w.eval("closeRecordView&&closeRecordView()");
 // delete guard
 w.eval("_deleteRecordById('job','old2')"); await sleep(500);
 ck(writes.length===0,'delete of older-only job sends nothing: '+JSON.stringify(writes));
 // server deletes old3 + reopens old2 -> next pull untrims
 server.old3.deleted=true; server.old2.data.process='production';
 await w.eval("_syncPullAndMerge('job', ipLoad(), ipSave)"); await sleep(2500);
 ck(!w.eval('_trimmedJobIds()').old3&&!w.eval('_trimmedJobIds()').old2,'deleted/reopened jobs leave the trimmed set');
 ck(ids().indexOf('old2')>-1&&ids().indexOf('old3')===-1,'reopened old2 is back locally, deleted old3 is gone: '+ids());
 // offline failure path
 w.eval("_olderJobsState().loaded=false;_olderJobsState().failed=false");
 // RELOAD with the stored data (fresh server state)
 const stored={};for(let i=0;i<w.localStorage.length;i++){const k=w.localStorage.key(i);stored[k]=w.localStorage.getItem(k);}
 server.old3.deleted=false; server.old2.data.process='finished'; writes.length=0;
 const dom2=make(stored); w=dom2.window; await sleep(6000);
 console.log('reload local ids:',ids(),'| trimmed:',Object.keys(w.eval('_trimmedJobIds()')).sort().join(','));
 ck(writes.length===0,'reload: zero server writes/deletes: '+JSON.stringify(writes));
 console.log('state',JSON.stringify(w.eval('(function(){var s=_olderJobsState();return {loaded:s.loaded,failed:s.failed,loading:s.loading,map:Object.keys(s.map)}})()')),w.eval('_jobsForReports().length'));ck(w.eval("_recNorm(_jobsForReports(),'job')").length===7,'reload: reports still see all 7 jobs');
 ck(ids().indexOf('recent1')>-1&&ids().indexOf('pend1')>-1&&ids().indexOf('sample1')>-1,'reload: protected jobs still on device');
 console.log(fails?'FAILED '+fails:'ALL PASS');
 process.exit(fails?1:0);
})();

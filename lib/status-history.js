'use strict';
// Metadata only. Polling observes snapshots, not every source event.
const LIMIT = 100;
const MAX_AGE = 30 * 86400000;
const STATES = new Set(['idle','running','waiting','waiting-input','done','failed','stopped','ended','sync-paused','unknown','error']);
function clean(value, now) {
  if (!value || !Number.isFinite(value.at) || value.at > now || now-value.at > MAX_AGE
      || !Number.isFinite(value.evidenceAt) || !STATES.has(value.state) || !STATES.has(value.raw)) return null;
  const out = {at:value.at,evidenceAt:value.evidenceAt,read:value.read===true};
  for (const key of ['sessionId','runId','state','raw','source','event','reason']) {
    if (typeof value[key] !== 'string' || value[key].length > 200) return null;
    out[key]=value[key];
  }
  return out;
}
function signature(item) {
  return JSON.stringify([item.runId,item.state,item.raw,item.read,item.reason]);
}
function createStatusHistory({now=Date.now}={}) {
  let entries=[], dirty=false, writing=null;
  function restore(saved) {
    entries=(Array.isArray(saved)?saved:[]).map(x=>clean(x,now())).filter(Boolean).slice(-LIMIT);
  }
  function observe(rows, records) {
    const at=now(), retained=entries.filter(x=>at-x.at<=MAX_AGE);
    if(retained.length!==entries.length)dirty=true;
    entries=retained;
    const latest=new Map(entries.map(x=>[x.sessionId,x]));
    const sources=new Map(records.map(x=>[x.sessionId,x]));
    for(const row of rows) {
      const source=sources.get(row.sessionId)||{};
      const item=clean({sessionId:row.sessionId,runId:row.runId||'',state:row.state,raw:row.raw,
        read:row.read===true,at,evidenceAt:source.ts,source:source.source||'hook',event:source.lastEvent||'',
        reason:row.state==='sync-paused'?(source.syncPaused?'source-unavailable':'liveness-unconfirmed'):'source-state'},at);
      if(!item)continue;
      const previous=latest.get(item.sessionId);
      if(previous && signature(previous)===signature(item))continue;
      entries.push(item);latest.set(item.sessionId,item);dirty=true;
    }
    entries=entries.slice(-LIMIT);
  }
  function flush(pet) {
    if(writing)return writing;
    if(!dirty || !pet?.storage?.set)return Promise.resolve();
    writing=(async()=>{
      while(dirty) {
        dirty=false;
        try { await pet.storage.set('statusTransitions',entries.map(x=>({...x}))); }
        catch(_) {dirty=true;break;}
      }
    })().finally(()=>{writing=null;});
    return writing;
  }
  return {restore,observe,flush};
}
module.exports={createStatusHistory};

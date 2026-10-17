/** Family health journal. Observations and interpretations are separate. */
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';

const KINDS=new Set(['blood_pressure','temperature_c','glucose_mg_dl','symptom_note']);
const MODES=new Set(['general','performance']);
const isoDate=(when,zone)=>{
 const d=new Date(when);if(Number.isNaN(d.getTime()))throw Error('Invalid observedAt');
 const ps=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
 const f=k=>ps.find(p=>p.type===k).value;
 return f('year')+'-'+f('month')+'-'+f('day');
};
const shift=(day,n)=>{const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const mean=x=>x.length?Math.round(x.reduce((a,b)=>a+b,0)/x.length*100)/100:null;
export function summarizeSeries(rows,key,windowDays,endDate=null){
 const vals=rows.filter(r=>Number.isFinite(r[key])).map(r=>({date:r.date,value:r[key]})).sort((a,b)=>a.date.localeCompare(b.date));
 const cutoff=endDate?shift(endDate,-Math.floor(windowDays/2)+1):null;
 const earlier=vals.filter(x=>cutoff&&x.date<cutoff).map(x=>x.value);
 const later=vals.filter(x=>cutoff&&x.date>=cutoff).map(x=>x.value);
 const change=earlier.length>=3&&later.length>=3?Math.round((mean(later)-mean(earlier))*100)/100:null;
 return {samples:vals.length,mean:mean(vals.map(x=>x.value)),first:vals.at(0)?.value??null,last:vals.at(-1)?.value??null,
  recentMinusEarlier:change,comparisonAvailable:change!==null};
}
export function createFamilyHealth({accounts,dir,now=()=>new Date()}){
 if(!accounts||!dir||!path.isAbsolute(dir))throw Error('Family accounts and absolute data directory required');
 const cache=new Map();
 const memberDb=id=>{
  accounts.member(id);
  if(!cache.has(id)){
   const db=new DatabaseSync(path.join(dir,'member-health-'+id+'.db'));
   db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS health_observations ("
     +"id TEXT PRIMARY KEY,observed_at TEXT NOT NULL,date TEXT NOT NULL,kind TEXT NOT NULL,"
     +"systolic REAL,diastolic REAL,value REAL,context TEXT,note TEXT,"
     +"source_event_id TEXT UNIQUE,source_hash TEXT,created_at TEXT NOT NULL);"
     +"CREATE TABLE IF NOT EXISTS member_health_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);");
   cache.set(id,db);
  }
  return cache.get(id);
 };
 const settings=id=>memberDb(id).prepare("SELECT value FROM member_health_settings WHERE key='mode'").get()?.value??'general';
 const setMode=(principal,mode)=>{
  if(!MODES.has(mode))throw Error('Invalid wellness mode');
  memberDb(principal.id).prepare("INSERT INTO member_health_settings(key,value) VALUES('mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(mode);
  return {ok:true,memberId:principal.id,mode};
 };
 const validMeasure=(v,low,high)=>typeof v==='number'&&Number.isFinite(v)&&v>=low&&v<=high;
 const record=(principal,entry)=>{
  const id=principal.id,m=accounts.member(id);
  if(!KINDS.has(entry.kind))throw Error('Unknown health observation kind');
  const observedAt=entry.observedAt??now().toISOString();
  const parsed=new Date(observedAt);if(Number.isNaN(parsed.getTime())||parsed.getTime()>now().getTime()+300000)throw Error('Invalid or future observedAt');
  const date=isoDate(observedAt,m.timeZone);
  if(entry.kind==='blood_pressure'&&(!validMeasure(entry.systolic,50,270)||!validMeasure(entry.diastolic,30,180)||entry.diastolic>=entry.systolic))throw Error('Invalid blood pressure input');
  if(entry.kind==='temperature_c'&&!validMeasure(entry.value,30,43))throw Error('Invalid temperature input');
  if(entry.kind==='glucose_mg_dl'&&!validMeasure(entry.value,30,600))throw Error('Invalid glucose input');
  if(entry.kind==='symptom_note'&&(!entry.note||!entry.note.trim()))throw Error('Symptom note required');
  if(entry.note!=null&&(typeof entry.note!=='string'||entry.note.length>500))throw Error('Note too long');
  if(entry.sourceEventId!=null&&!/^[a-zA-Z0-9_.:\\-]{1,120}$/.test(entry.sourceEventId))throw Error('Invalid sourceEventId');
  const e={kind:entry.kind,observedAt:new Date(observedAt).toISOString(),date,
   systolic:entry.kind==='blood_pressure'?entry.systolic:null,diastolic:entry.kind==='blood_pressure'?entry.diastolic:null,
   value:entry.kind==='temperature_c'||entry.kind==='glucose_mg_dl'?entry.value:null,
   context:entry.context??null,note:entry.note??null};
  const hash=createHash('sha256').update(JSON.stringify(e)).digest('hex'),db=memberDb(id);
  if(entry.sourceEventId){const prev=db.prepare('SELECT id,source_hash FROM health_observations WHERE source_event_id=?').get(entry.sourceEventId);
   if(prev){if(prev.source_hash!==hash)throw Error('sourceEventId reused for different observation');return {ok:true,id:prev.id,date,duplicate:true};}}
  const obsId=randomUUID();
  db.prepare('INSERT INTO health_observations(id,observed_at,date,kind,systolic,diastolic,value,context,note,source_event_id,source_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(obsId,e.observedAt,e.date,e.kind,e.systolic,e.diastolic,e.value,e.context,e.note,entry.sourceEventId??null,hash,now().toISOString());
  return {ok:true,id:obsId,date,kind:entry.kind,duplicate:false};
 };
 const history=(principal,{days=30}={})=>{
  if(!Number.isInteger(days)||days<1||days>90)throw Error('days must be 1..90');
  const m=accounts.member(principal.id),end=isoDate(now(),m.timeZone),start=shift(end,-days+1);
  return {ok:true,memberId:m.id,fromDate:start,toDate:end,
   observations:memberDb(m.id).prepare('SELECT * FROM health_observations WHERE date BETWEEN ? AND ? ORDER BY date DESC, observed_at DESC').all(start,end)};
 };
 const report=(principal,{memberId,days=30}={})=>{
  if(!Number.isInteger(days)||days<7||days>90)throw Error('days must be 7..90');
  const target=accounts.member(memberId??principal.id);
  if(!accounts.canRead(principal,target.id,'health_trends'))throw Error('Family health trend access denied');
  const end=isoDate(now(),target.timeZone),start=shift(end,-days+1);
  const data=accounts.engineFor({id:target.id}).execute('export_nutrition_data',{fromDate:start,toDate:end});
  const ledger=(data.ledger||[]).slice().sort((a,b)=>a.date.localeCompare(b.date));
  const obs=memberDb(target.id).prepare('SELECT date,kind,systolic,diastolic,value FROM health_observations WHERE date BETWEEN ? AND ? ORDER BY date').all(start,end);
  const bp=obs.filter(x=>x.kind==='blood_pressure');
  const series={
   weightKg:summarizeSeries(ledger,'scale_weight_kg',days,end),
   sleepHours:summarizeSeries(ledger,'sleep_hours',days,end),
   restingHeartRate:summarizeSeries(ledger,'rhr_bpm',days,end),
   steps:summarizeSeries(ledger,'steps',days,end),
   systolic:summarizeSeries(bp,'systolic',days,end),
   diastolic:summarizeSeries(bp,'diastolic',days,end)
  };
  return {ok:true,memberId:target.id,mode:settings(target.id),period:{fromDate:start,toDate:end,days},
   dataQuality:{weightDays:ledger.filter(r=>r.scale_weight_kg!=null).length,sleepDays:ledger.filter(r=>r.sleep_hours!=null).length,
    bloodPressureReadings:bp.length,notesExcluded:true},series,
   findings:Object.entries(series).filter(([,s])=>s.comparisonAvailable).map(([metric,s])=>({metric,change:s.recentMinusEarlier,
     interpretation:'Observed recent-versus-earlier mean difference; not a diagnostic threshold'})),
   limitations:['Incomplete recording may distort trends','No diagnosis, risk score, medical treatment or automatic alert','Notes and raw symptoms are not shared through trends']};
 };
 return {record,history,report,setMode,settings,close(){for(const db of cache.values())db.close();}};
}

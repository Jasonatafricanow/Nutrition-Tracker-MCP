/** Shared-family NAS context, not a SaaS tenant or login system.
 * The sole remote MCP token protects the whole trusted household. memberId denotes
 * a person in the data, NOT an authentication/permission boundary.
 * Existing single-person Nutrition Tracker engines are reused unchanged.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MEMBER_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const KINDS = new Set(['blood_pressure','temperature_c','glucose_mg_dl','symptom_note']);
const shiftDay = (day,n) => {const d=new Date(`${day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const median = vals => {if(!vals.length)return null;const a=vals.toSorted((a,b)=>a-b);return a[Math.floor(a.length/2)];};
const dayInZone = (d,zone) => {
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
  const part=x=>parts.find(p=>p.type===x).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const bounded = (v,a,b) => typeof v==='number'&&Number.isFinite(v)&&v>=a&&v<=b;

export function validateHouseholdConfig(config){
  if(!config||!Array.isArray(config.members)||config.members.length<1||config.members.length>20)throw Error('household members must contain 1..20 entries');
  const ids=new Set();
  return config.members.map(m=>{
    if(!m||typeof m.id!=='string'||!MEMBER_ID.test(m.id)||ids.has(m.id))throw Error('invalid or duplicate memberId');
    ids.add(m.id);
    if(typeof m.name!=='string'||!m.name.trim()||m.name.length>60)throw Error('member name required');
    const mode=m.mode??'general';if(!['general','performance'].includes(mode))throw Error('unknown member mode');
    const timeZone=m.timeZone??config.timeZone??'UTC';
    try {new Intl.DateTimeFormat('en-US',{timeZone});}catch{throw Error('invalid member timezone');}
    return {id:m.id,name:m.name.trim(),mode,timeZone};
  });
}

export function createHousehold({configPath,dir,engineFactory,now=()=>new Date()}={}){
  if(!path.isAbsolute(configPath??'')||!path.isAbsolute(dir??''))throw Error('household paths must be absolute');
  if(typeof engineFactory!=='function')throw Error('engineFactory required');
  const members=validateHouseholdConfig(JSON.parse(readFileSync(configPath,'utf8')));
  const byId=new Map(members.map(m=>[m.id,m]));
  mkdirSync(dir,{recursive:true,mode:0o700});
  const database=new DatabaseSync(path.join(dir,'household-health.db'));
  database.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL, observed_at TEXT NOT NULL,
      date TEXT NOT NULL, kind TEXT NOT NULL, systolic REAL, diastolic REAL,
      value REAL, note TEXT, source_event_id TEXT,
      UNIQUE(member_id, source_event_id)
    );
    CREATE TABLE IF NOT EXISTS mentions (
      member_id TEXT NOT NULL, signal TEXT NOT NULL, last_date TEXT NOT NULL,
      PRIMARY KEY(member_id, signal)
    );`);
  const engines=new Map();
  const member=id=>{const m=byId.get(id);if(!m)throw Error('unknown memberId');return m;};
  const memberEngine=id=>{
    const m=member(id);
    if(!engines.has(id))engines.set(id,engineFactory(path.join(dir,`nutrition-${id}.db`),{timeZone:m.timeZone,now}));
    return engines.get(id);
  };
  const memberTool=(memberId,tool,args={})=>{
    if(typeof tool!=='string'||tool==='get_household_context')throw Error('invalid nutrition tool');
    return memberEngine(memberId).execute(tool,args,`HOUSEHOLD:${memberId}`);
  };
  const logObservation = ({memberId,kind,observedAt,note,sourceEventId,systolic,diastolic,value})=>{
    const m=member(memberId);
    if(!KINDS.has(kind))throw Error('unknown observation kind');
    const dateTime=observedAt?new Date(observedAt):now();
    if(Number.isNaN(dateTime.getTime())||dateTime.getTime()>now().getTime()+300000)throw Error('invalid observation time');
    if(kind==='blood_pressure'&&(!bounded(systolic,50,270)||!bounded(diastolic,30,180)||systolic<=diastolic))throw Error('invalid blood pressure');
    if(kind==='temperature_c'&&!bounded(value,30,43))throw Error('invalid temperature');
    if(kind==='glucose_mg_dl'&&!bounded(value,30,600))throw Error('invalid glucose');
    if(kind==='symptom_note'&&(!note||!note.trim()))throw Error('note required');
    if(note!=null&&(typeof note!=='string'||note.length>500))throw Error('note too long');
    if(sourceEventId!=null&&(!/^[\w.:\-]{1,120}$/.test(sourceEventId)))throw Error('invalid source event ID');
    const date=dayInZone(dateTime,m.timeZone);
    if(sourceEventId){
      const prev=database.prepare('SELECT * FROM observations WHERE member_id=? AND source_event_id=?').get(memberId,sourceEventId);
      if(prev){
        const normalized={kind,systolic:kind==='blood_pressure'?systolic:null,diastolic:kind==='blood_pressure'?diastolic:null,
          value:['temperature_c','glucose_mg_dl'].includes(kind)?value:null,note:note??null};
        if(Object.entries(normalized).some(([key,v])=>prev[key]!==v)|| (observedAt&&prev.observed_at!==dateTime.toISOString()))
          throw Error('sourceEventId already used for different health observation');
        return {ok:true,id:prev.id,duplicate:true};
      }
    }
    const id=randomUUID();
    database.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,memberId,dateTime.toISOString(),date,kind,kind==='blood_pressure'?systolic:null,kind==='blood_pressure'?diastolic:null,['temperature_c','glucose_mg_dl'].includes(kind)?value:null,note??null,sourceEventId??null);
    return {ok:true,id,memberId,kind,date,duplicate:false};
  };
  const observations=(memberId,days=14)=>{
    const m=member(memberId);if(!Number.isInteger(days)||days<1||days>90)throw Error('days must be 1..90');
    const end=dayInZone(now(),m.timeZone),start=shiftDay(end,-days+1);
    return database.prepare('SELECT date,kind,systolic,diastolic,value,note FROM observations WHERE member_id=? AND date BETWEEN ? AND ? ORDER BY date DESC LIMIT 100').all(memberId,start,end);
  };
  function context({days=14,memberId}={}){
    if(memberId)member(memberId);
    if(!Number.isInteger(days)||days<3||days>30)throw Error('days must be 3..30');
    return {ok:true,scope:'household_nas',members:members.filter(m=>!memberId||m.id===memberId).map(m=>{
      const snapshot=memberEngine(m.id).buildSnapshot();
      const rows=snapshot.history.filter(x=>x.date>=shiftDay(snapshot.date,-days+1)).toSorted((a,b)=>a.date.localeCompare(b.date));
      const today=snapshot.today;const obs=observations(m.id,days);
      const lastByKind={};for(const v of obs)if(lastByKind[v.kind]===undefined)lastByKind[v.kind]=v;
      const recent=rows.filter(r=>r.date>=shiftDay(snapshot.date,-1));
      const latestWith=key=>rows.toReversed().find(r=>r[key]!=null);
      const recentSleep=recent.find(r=>r.sleep_hours!=null);
      const recentRhr=recent.find(r=>r.rhr_bpm!=null);
      const priorRhr=rows.filter(r=>r.rhr_bpm!=null&&r.date<recentRhr?.date).map(r=>r.rhr_bpm);
      const active=[];
      if(recentSleep&&recentSleep.sleep_hours<6)active.push({key:'short_sleep',observation:`最近记录睡眠 ${recentSleep.sleep_hours} 小时`,date:recentSleep.date});
      if(recentRhr&&priorRhr.length>=3&&recentRhr.rhr_bpm-median(priorRhr)>=8)active.push({key:'rhr_change',observation:`最近静息心率 ${recentRhr.rhr_bpm} bpm，较此前记录偏高`,date:recentRhr.date});
      const hints=active.filter(s=>{
        const previous=database.prepare('SELECT last_date FROM mentions WHERE member_id=? AND signal=?').get(m.id,s.key)?.last_date;
        return !previous||previous<shiftDay(snapshot.date,-2);
      });
      return {memberId:m.id,name:m.name,mode:m.mode,asOf:snapshot.date,
        nutrition:m.mode==='performance'?{carbLevel:today.carb_level,training:!!today.is_training_day,
          remaining:{kcal:Math.round(snapshot.targets.kcal-today.intake_kcal),p:Math.round(snapshot.targets.p-today.p_g),c:Math.round(snapshot.targets.c-today.c_g),f:Math.round(snapshot.targets.f-today.f_g)},
          targets:snapshot.targets}:null,
        latest:{weightKg:today.scale_weight_kg??null,weightTrendKg:snapshot.profile.ewma_weight_kg??null,
          sleepHours:recentSleep?.sleep_hours??null,sleepDate:recentSleep?.date??null,
          deepSleepPct:latestWith('deep_sleep_pct')?.deep_sleep_pct??null,deepSleepDate:latestWith('deep_sleep_pct')?.date??null,restingHeartRate:recentRhr?.rhr_bpm??null,restingHeartRateDate:recentRhr?.date??null,
          hrvMs:latestWith('hrv_ms')?.hrv_ms??null,hrvMetric:latestWith('hrv_ms')?.hrv_metric??null,hrvDate:latestWith('hrv_ms')?.date??null,
          steps:latestWith('steps')?.steps??null,stepsDate:latestWith('steps')?.date??null,activeKcal:latestWith('active_kcal')?.active_kcal??null,activeKcalDate:latestWith('active_kcal')?.date??null,
          recoveryObservation:today.cns_status??null,
          bloodPressure:lastByKind.blood_pressure?{systolic:lastByKind.blood_pressure.systolic,diastolic:lastByKind.blood_pressure.diastolic,date:lastByKind.blood_pressure.date}:null,
          temperatureC:lastByKind.temperature_c?{value:lastByKind.temperature_c.value,date:lastByKind.temperature_c.date}:null,
          glucoseMgDl:lastByKind.glucose_mg_dl?{value:lastByKind.glucose_mg_dl.value,date:lastByKind.glucose_mg_dl.date}:null},
        observations:obs.filter(x=>x.kind!=='symptom_note').slice(0,12),
        noteworthy:hints,
        dataQuality:{recordedDays:rows.filter(x=>x.sleep_hours!=null||x.rhr_bpm!=null||x.scale_weight_kg!=null).length,
          note:'Missing measurements are unknown; these are observations, not diagnoses'}
      };
    })};
  }
  const acknowledge=(memberId,signal)=>{
    const m=member(memberId);
    if(!['short_sleep','rhr_change'].includes(signal))throw Error('unknown signal');
    const day=dayInZone(now(),m.timeZone);
    database.prepare('INSERT INTO mentions VALUES(?,?,?) ON CONFLICT(member_id,signal) DO UPDATE SET last_date=excluded.last_date').run(memberId,signal,day);
    return {ok:true,memberId,signal,lastMentioned:day};
  };
  return {members,member,memberTool,logObservation,observations,context,acknowledge,
    close(){for(const e of engines.values())e.close();database.close();}};
}

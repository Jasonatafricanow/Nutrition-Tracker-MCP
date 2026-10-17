/** Small Agent-facing MCP surface. Existing engine is the only writer/calculator.
 * Normal Agent sessions see two tools; legacy tools remain opt-in for older hosts.
 */
import {TOOL_DEFS} from './engine.js';

const READ_GROUPS = {
  daily: ['household','member','meals','foods','health_history','templates'],
  photo: ['get_photo_estimation_protocol','get_photo_meal_draft'],
  planning: ['get_snapshot','get_agent_context','set_day_context','update_weekly_schedule','calibrate_metabolic_tdee'],
  history: ['get_meal_history','get_meal_corrections','export_nutrition_data'],
  extras: ['save_meal_template','log_meal_template','update_supplement_stack','add_food_to_library']
};
const OPERATIONS = Object.freeze({
  meal:'log_meal_items', checkin:'log_morning_checkin', correction:'update_meal_item',
  photo_stage:'stage_photo_estimate', photo_confirm:'confirm_photo_meal', photo_discard:'discard_photo_meal',
  template_save:'save_meal_template', template_log:'log_meal_template',
  supplement:'update_supplement_stack', plan:'set_day_context', profile:'set_profile',
  intake_complete:'mark_intake_complete', food_add:'add_food_to_library'
});
const RESTRICTED = new Set(['get_snapshot','get_agent_context','get_meal_history','get_meal_corrections','get_photo_meal_draft','get_photo_estimation_protocol','search_foods','list_meal_templates','export_nutrition_data']);
const clean = v=>Object.fromEntries(Object.entries(v).filter(([,x])=>x!==null&&x!==undefined));

export function createAgentInterface({engine,household=null,usda=null}={}){
 if(!engine)throw Error('engine required');
 const forMember=(id)=>{
   if(household){if(!id)throw Error('memberId required for personal operations in household mode');
     household.member(id);return (name,args)=>household.memberTool(id,name,args);
   }
   if(id)throw Error('memberId requires household mode');
   return (name,args)=>engine.execute(name,args,'MCP_COMPACT');
 };
 const projectHousehold=(raw,focus='daily')=>({ok:true,scope:raw.scope,
   members:raw.members.map(m=>{
     const base={memberId:m.memberId,name:m.name,mode:m.mode,asOf:m.asOf};
     if(['daily','food','all'].includes(focus)&&m.nutrition){
       base.nutrition={carbLevel:m.nutrition.carbLevel,training:m.nutrition.training,
         remaining:m.nutrition.remaining,targets:m.nutrition.targets};
     }
     if(['daily','health','all'].includes(focus)){
       base.health=clean({sleepHours:m.latest.sleepHours,sleepDate:m.latest.sleepDate,
         restingHeartRate:m.latest.restingHeartRate,recoveryObservation:m.latest.recoveryObservation,hrvMs:m.latest.hrvMs,hrvMetric:m.latest.hrvMetric,
         deepSleepPct:m.latest.deepSleepPct,steps:m.latest.steps,activeKcal:m.latest.activeKcal,
         weightKg:m.latest.weightKg,weightTrendKg:m.latest.weightTrendKg,
         bloodPressure:m.latest.bloodPressure,temperatureC:m.latest.temperatureC,glucoseMgDl:m.latest.glucoseMgDl});
       base.noteworthy=m.noteworthy.slice(0,2);
     }
     if(focus==='all')base.dataQuality=m.dataQuality;
     return base;
   })});
 async function query({view='household',memberId,focus='daily',date,days=14,queries=[],query:term='',limit=5,draftId,domain='daily',source='local'}={}){
   if(view==='capabilities'){
     if(!(domain in READ_GROUPS))throw Error('unknown capabilities domain');
     return {ok:true,domain,available:READ_GROUPS[domain],writeOperations:Object.keys(OPERATIONS),
       note:'Default use nutrition_query/execute; request photo MCP Prompt only for photograph tasks. Legacy full tools require MCP_TOOL_SURFACE=full.'};
   }
   if(view==='household'||view==='member'){
     if(!household){if(view==='household')return {ok:true,scope:'single_person',...await query({view:'member',focus})};
       const a=forMember(undefined)('get_agent_context',{});
       return {ok:true,scope:'single_person',date:a.date,carbLevel:a.carbLevel,
         targets:a.target,remaining:a.remaining,consumed:a.consumed,
         recentMeals:a.recentMeals.slice(-3),intakeComplete:a.intakeComplete,
         pendingPhotoDrafts:a.pendingPhotoDrafts.slice(0,3)};
     }
     if(view==='member'&&!memberId)throw Error('memberId required for member view');
     return projectHousehold(household.context({days,...(memberId?{memberId}:{})}),focus);
   }
   if(view==='health_history'){
     if(!household)throw Error('health_history requires household mode');
     if(!memberId)throw Error('memberId required');
     const items=household.observations(memberId,days);
     return {ok:true,memberId,observations:items.slice(0,20),truncated:items.length>20};
   }
   if(view==='foods'){
     const inputs=queries.length?queries:(term?[term]:[]);
     if(!inputs.length||inputs.length>6||inputs.some(q=>typeof q!=='string'||!q.trim()||q.length>100))throw Error('provide 1–6 food queries');
     if(source==='usda'){
       if(!usda)throw Error('USDA adapter unavailable');
       const results=[];for(const q of inputs)results.push({query:q,...await usda.search(q,Math.min(limit,5))});
       return {ok:true,source:'usda',results};
     }
     const call=forMember(memberId);return {ok:true,source:'local',results:inputs.map(q=>{
       const v=call('search_foods',{query:q,limit:Math.min(limit,5)});
       return {query:q,foods:v.foods.map(({id,name,p,c,f})=>({id,name,p,c,f}))};
     })};
   }
   const call=forMember(memberId);
   if(view==='meals'){
     const r=call('get_meal_history',date?{date}:{});
     return {...r,meals:r.meals.slice(-25),truncated:r.meals.length>25};
   }
   if(view==='templates'){
     const r=call('list_meal_templates',{query:term,limit:Math.min(limit,10)});
     return r;
   }
   if(view==='photo_draft'){
     if(!draftId)throw Error('draftId required');return call('get_photo_meal_draft',{draftId});
   }
   if(view==='nutrition_detail'){
     if(!term||!RESTRICTED.has(term))throw Error('unsupported read tool; use capabilities to discover');
     return call(term, date?{date}:{});
   }
   throw Error('unknown query view');
 }
 function execute({memberId,operation,args={},tool,includeContext=true}={}){
   const afterWrite=(out)=>{
     if(!includeContext||!['meal','checkin','health_observation','correction'].includes(operation))return out;
     if(household){const r=household.context({days:3,memberId});
       const c=projectHousehold(r,operation==='meal'||operation==='correction'?'food':'health');
       return {...out,context:c.members[0]};
     }
     const x=engine.execute('get_agent_context',{},'MCP_COMPACT');
     return {...out,context:{date:x.date,remaining:x.remaining,consumed:x.consumed,intakeComplete:x.intakeComplete}};
   };

   if(!operation)throw Error('operation required');
   if(operation==='health_observation'){
     if(!household)throw Error('health_observation requires household mode');
     if(!memberId)throw Error('memberId required');
     return afterWrite(household.logObservation({memberId,...args}));
   }
   if(operation==='acknowledge'){
     if(!household)throw Error('acknowledge requires household mode');
     if(!memberId)throw Error('memberId required');
     return household.acknowledge(memberId,args.signal);
   }
   const name=operation==='advanced'?tool:OPERATIONS[operation];
   if(!name||!TOOL_DEFS[name]||RESTRICTED.has(name))throw Error('unsupported write operation');
   // Delegate schema validation, business rules, idempotency and transaction boundaries.
   const result=forMember(memberId)(name,args);
   return afterWrite(result);
 }
 return {query,execute,projectHousehold};
}

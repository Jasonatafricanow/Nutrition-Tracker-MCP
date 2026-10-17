/** Compact, non-clinical 7/30 day observations from the existing SQLite export. */
export function dayMinus(day,n){
  const d=new Date(day+'T12:00:00Z');
  if(Number.isNaN(d.getTime()))throw Error('invalid report date');
  d.setUTCDate(d.getUTCDate()-n);
  return d.toISOString().slice(0,10);
}
const avg=(xs,digits=1)=>xs.length?Math.round((xs.reduce((a,b)=>a+b,0)/xs.length)*10**digits)/10**digits:null;
const numeric=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
export function summarizeNutritionExport(data,days){
  if(![7,30].includes(days))throw Error('report days must be 7 or 30');
  const rows=data.ledger??[], meals=data.meals??[];
  const mealDays=new Set(meals.map(m=>m.date));
  const reportedIntake=rows.filter(r=>mealDays.has(r.date)&&numeric(r.intake_kcal)!==null);
  const weights=rows.filter(r=>numeric(r.scale_weight_kg)!==null);
  const sleep=rows.map(r=>numeric(r.sleep_hours)).filter(x=>x!==null);
  const rhr=rows.map(r=>numeric(r.rhr_bpm)).filter(x=>x!==null);
  const steps=rows.map(r=>numeric(r.steps)).filter(x=>x!==null);
  const weightChange=weights.length>=2?
    Math.round((weights.at(-1).scale_weight_kg-weights[0].scale_weight_kg)*100)/100:null;
  return {ok:true,periodDays:days,fromDate:data.fromDate,toDate:data.toDate,
    nutrition:{daysWithMeals:mealDays.size,mealItems:meals.length,estimatedItems:meals.filter(m=>String(m.source_kind||'').includes('estimate')).length,
      meanKcalOnLoggedDays:avg(reportedIntake.map(r=>r.intake_kcal),0),
      completeDays:rows.filter(r=>r.intake_complete===1).length},
    health:{sleepDays:sleep.length,averageSleepHours:avg(sleep),rhrDays:rhr.length,averageRhrBpm:avg(rhr),
      stepsDays:steps.length,averageSteps:avg(steps,0),
      weightMeasurements:weights.length,latestWeightKg:weights.at(-1)?.scale_weight_kg??null,weightChangeKg:weightChange},
    interpretation:'Unlogged days and unmeasured health metrics are unknown, not zero. Estimated meals are not clinical measurements or automatic TDEE calibration evidence.'};
}

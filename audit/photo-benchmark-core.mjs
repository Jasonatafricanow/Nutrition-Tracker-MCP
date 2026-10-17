/**
 * Offline scoring for externally produced PhotoEstimateV1 outputs.
 * Reference masses and human correspondence labels are kept separate from
 * vision predictions to avoid contaminating the model prompt.
 * This intentionally does not infer food identity from string similarity.
 */
export const BENCHMARK_VERSION = 'nutrition.photo_benchmark.v1';
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const validMass = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const unique = (array, context) => {
  assert(new Set(array).size === array.length, `Duplicate ${context}`);
};
const ratio = (numerator, denominator) => denominator ? Number((numerator / denominator).toFixed(4)) : null;
const average = xs => xs.length ? Number((xs.reduce((a,b)=>a+b,0)/xs.length).toFixed(4)) : null;
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a,b)=>a-b);
  return Number((s.length % 2 ? s[(s.length-1)/2] : (s[s.length/2-1]+s[s.length/2])/2).toFixed(4));
}
function validateCollection(doc, label) {
  assert(isObject(doc), `${label} must be an object`);
  assert(doc.schemaVersion === BENCHMARK_VERSION, `${label}: unexpected schemaVersion`);
  assert(Array.isArray(doc.cases) && doc.cases.length > 0, `${label}: cases must be nonempty`);
  unique(doc.cases.map(c=>c.caseId), `${label} caseId`);
  for(const c of doc.cases) assert(typeof c.caseId==='string' && c.caseId.trim(), `${label}: invalid caseId`);
  return new Map(doc.cases.map(c=>[c.caseId,c]));
}
function caseScore(reference, prediction, review) {
  const id = reference.caseId;
  assert(Array.isArray(reference.referenceItems), `${id}: missing weighed reference items`);
  assert(isObject(prediction.estimate) && prediction.estimate.schemaVersion==='nutrition.photo_estimate.v1', `${id}: wrong estimate schema version`);
  assert(isObject(prediction.estimate.imageAssessment), `${id}: missing imageAssessment`);
  assert(['known_size','unverified_plate','none'].includes(prediction.estimate.imageAssessment.scaleReference), `${id}: invalid scale reference`);
  assert(Array.isArray(prediction.estimate.items) && prediction.estimate.items.length>0, `${id}: empty estimates`);
  assert(Array.isArray(prediction.estimate.hiddenOrUnquantified), `${id}: missing hiddenOrUnquantified`);
  assert(Array.isArray(prediction.estimate.questions), `${id}: missing follow-up questions`);
  assert(Array.isArray(review.assignments), `${id}: missing human adjudications`);
  unique(reference.referenceItems.map(i=>i.id), `${id} reference item id`);
  unique(prediction.estimate.items.map(i=>i.id), `${id} prediction item id`);
  unique(review.assignments.map(a=>a.predictedId), `${id} adjudicated predictedId`);
  const truth = new Map();
  for(const r of reference.referenceItems) {
    assert(typeof r.id==='string' && r.id.length>0 && typeof r.name==='string' && validMass(r.grams) && typeof r.visible==='boolean', `${id}: invalid weighed reference`);
    truth.set(r.id,r);
  }
  const predicted = new Map();
  for(const p of prediction.estimate.items) {
    assert(typeof p.id==='string' && p.id.length>0 && isObject(p.ediblePortion), `${id}: malformed prediction item`);
    const {grams,minGrams,maxGrams,method} = p.ediblePortion;
    if(method==='not_estimable') assert(grams===null&&minGrams===null&&maxGrams===null,`${id}: invalid not_estimable`);
    else assert(validMass(grams) && validMass(minGrams) && validMass(maxGrams) && minGrams <= grams && grams <= maxGrams,`${id}: invalid estimated gram interval`);
    predicted.set(p.id,p);
  }
  assert(review.assignments.length===predicted.size, `${id}: every prediction must be adjudicated exactly once`);
  const usedReferences = new Set();
  let correct=0,broad=0,wrong=0,unmatched=0,unjudgeable=0,abstentions=0,scoredMass=0,covered=0;
  let absErrorSum=0, signedErrorSum=0, refGramSum=0;
  const absoluteErrors=[], percentageErrors=[], intervalWidths=[];
  for(const a of review.assignments) {
    assert(predicted.has(a.predictedId),`${id}: review points to missing prediction ${a.predictedId}`);
    assert(['correct','broad','wrong','unmatched','unjudgeable'].includes(a.identity),`${id}: invalid identity adjudication`);
    assert(a.identity==='unmatched'||a.identity==='unjudgeable' ? a.referenceId===null : (typeof a.referenceId==='string'&&truth.has(a.referenceId)), `${id}: review reference link invalid`);
    if(a.referenceId !== null) {
      assert(!usedReferences.has(a.referenceId),`${id}: reference assigned to multiple predictions`);
      usedReferences.add(a.referenceId);
    }
    if(a.identity==='correct') correct++;
    if(a.identity==='broad') broad++;
    if(a.identity==='wrong') wrong++;
    if(a.identity==='unmatched') unmatched++;
    if(a.identity==='unjudgeable') unjudgeable++;
    const p=predicted.get(a.predictedId).ediblePortion;
    if(p.grams===null) abstentions++;
    if((a.identity==='correct'||a.identity==='broad') && truth.get(a.referenceId).visible && p.grams!==null) {
      const actual=truth.get(a.referenceId).grams;
      const err=p.grams-actual;
      absErrorSum+=Math.abs(err);signedErrorSum+=err;refGramSum+=actual;
      absoluteErrors.push(Math.abs(err));percentageErrors.push(100*Math.abs(err)/actual);
      intervalWidths.push(p.maxGrams-p.minGrams);
      scoredMass++;
      if(p.minGrams<=actual && actual<=p.maxGrams) covered++;
    }
  }
  const visibleCount=reference.referenceItems.filter(r=>r.visible).length;
  const positiveMatches=review.assignments.filter(a=>['correct','broad'].includes(a.identity) && truth.get(a.referenceId).visible).length;
  const hiddenCount=reference.referenceItems.filter(r=>!r.visible).length;
  return {
    caseId:id, scaleReference:prediction.estimate.imageAssessment.scaleReference,
    visibleReferenceItems:visibleCount,hiddenReferenceItems:hiddenCount,predictions:predicted.size,
    adjudicated:predicted.size-unjudgeable,correct,broad,wrong,unmatched,unjudgeable,
    positiveMatches,abstentions,scoredMass,covered,absErrorSum,signedErrorSum,refGramSum,
    absoluteErrors,percentageErrors,intervalWidths,
    flaggedHidden:prediction.estimate.hiddenOrUnquantified.length>0,
    followUpQuestions:prediction.estimate.questions.length
  };
}
function aggregate(cases) {
  const sum=k=>cases.reduce((n,c)=>n+c[k],0);
  const totalVisible=sum('visibleReferenceItems');
  const adjudicated=sum('adjudicated');
  const positives=sum('positiveMatches');
  const m=sum('scoredMass');
  const all=k=>cases.flatMap(c=>c[k]);
  return {
    cases:cases.length, visibleReferenceItems:totalVisible,hiddenReferenceItems:sum('hiddenReferenceItems'),
    predictedItems:sum('predictions'),adjudicatedItems:adjudicated,
    correctItems:sum('correct'),broadItems:sum('broad'),wrongItems:sum('wrong'),unmatchedItems:sum('unmatched'),unjudgeableItems:sum('unjudgeable'),
    identificationPrecision:ratio(positives,adjudicated),identificationRecall:ratio(positives,totalVisible),
    strictIdentificationRecall:ratio(sum('correct'),totalVisible),
    unestimatedPortions:sum('abstentions'),weightAbstentionRate:ratio(sum('abstentions'),sum('predictions')),
    scoredWeights:m,gramMAE:ratio(sum('absErrorSum'),m),gramBias:ratio(sum('signedErrorSum'),m),
    weightedAbsolutePercentageError:sum('refGramSum')?Number((100*sum('absErrorSum')/sum('refGramSum')).toFixed(2)):null,
    medianAbsolutePercentageError:median(all('percentageErrors')),
    intervalCoverage:ratio(sum('covered'),m),meanIntervalWidthGrams:average(all('intervalWidths')),
    hiddenCaseFlagRate:ratio(cases.filter(c=>c.hiddenReferenceItems>0&&c.flaggedHidden).length,cases.filter(c=>c.hiddenReferenceItems>0).length),
    avgFollowUpQuestions:average(cases.map(c=>c.followUpQuestions))
  };
}
export function evaluatePhotoBenchmark({references,predictions,reviews}) {
  const refs=validateCollection(references,'references');
  const preds=validateCollection(predictions,'predictions');
  const revs=validateCollection(reviews,'reviews');
  assert(references.datasetKind==='synthetic' || references.datasetKind==='weighed_photos','references: datasetKind must be synthetic or weighed_photos');
  assert(isObject(predictions.run) && typeof predictions.run.modelId==='string' && predictions.run.modelId.trim() && typeof predictions.run.promptSha256==='string' && /^[0-9a-f]{64}$/i.test(predictions.run.promptSha256),'predictions: modelId and promptSha256 required');
  assert(predictions.run.referencesHiddenFromAgent===true,'predictions: blind reference isolation must be explicitly attested');
  assert(refs.size===preds.size&&refs.size===revs.size,'cases must match exactly across three inputs');
  const scored=[];
  for(const [caseId,reference] of refs) {
    assert(preds.has(caseId)&&revs.has(caseId),`case ${caseId} missing in predictions or reviews`);
    scored.push(caseScore(reference,preds.get(caseId),revs.get(caseId)));
  }
  const groups={};
  for(const scale of ['known_size','unverified_plate','none']){
    const group=scored.filter(c=>c.scaleReference===scale);
    if(group.length)groups[scale]=aggregate(group);
  }
  return {
    schemaVersion:BENCHMARK_VERSION,
    datasetKind:references.datasetKind,
    run:{modelId:predictions.run.modelId,promptSha256:predictions.run.promptSha256,referencesHiddenFromAgent:true},
    metrics:aggregate(scored),byScaleReference:groups,
    cases:scored.map(({absoluteErrors,percentageErrors,intervalWidths,absErrorSum,signedErrorSum,refGramSum,...rest})=>rest),
    caveat:references.datasetKind==='synthetic'
      ? 'SYNTHETIC scorer check only. These metrics DO NOT measure visual model accuracy.'
      : 'Measured-photo results apply only to this reviewed dataset; inspect sample size, cuisine and scale conditions before generalizing.'
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import {evaluatePhotoBenchmark} from '../audit/photo-benchmark-core.mjs';
const directory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../benchmark/examples');
const fixture=()=>Object.fromEntries(['references','predictions','reviews'].map(k=>[k,JSON.parse(fs.readFileSync(path.join(directory,k+'.json'),'utf8'))]));
const clone=()=>structuredClone(fixture());

test('synthetic scoring baseline is deterministic and transparently labeled',()=>{
 const a=evaluatePhotoBenchmark(clone()), b=evaluatePhotoBenchmark(clone());
 assert.deepEqual(a,b);assert.equal(a.datasetKind,'synthetic');
 assert.match(a.caveat,/DO NOT measure visual model accuracy/);
 assert.equal(a.metrics.cases,3);
 assert.equal(a.metrics.visibleReferenceItems,4);
 assert.equal(a.metrics.identificationRecall,.75);
 assert.equal(a.metrics.identificationPrecision,.6);
 assert.equal(a.metrics.gramMAE,12.5);
 assert.equal(a.metrics.weightedAbsolutePercentageError,7.58);
 assert.equal(a.metrics.intervalCoverage,1);
 assert.equal(a.metrics.scoredWeights,2);
});
test('weight-error metrics respond to a wrong estimate; interval coverage can fail',()=>{
 const x=clone();
 const portion=x.predictions.cases[0].estimate.items[0].ediblePortion;
 portion.grams=300;portion.minGrams=250;portion.maxGrams=400;
 const a=evaluatePhotoBenchmark(x);
 assert.equal(a.metrics.intervalCoverage,0.5);
 assert.equal(a.metrics.gramMAE,67.5);
});
test('no reference or a different case set cannot silently disappear from recall',()=>{
 const x=clone(); x.predictions.cases.pop();
 assert.throws(()=>evaluatePhotoBenchmark(x),/cases must match exactly/);
 const y=clone();y.predictions.cases[2].caseId='another-case';
 assert.throws(()=>evaluatePhotoBenchmark(y),/missing in predictions/);
});
test('each predicted item requires an explicit human adjudication',()=>{
 const x=clone();x.reviews.cases[0].assignments.pop();
 assert.throws(()=>evaluatePhotoBenchmark(x),/every prediction must be adjudicated/);
});
test('one reference item cannot validate multiple predicted fragments',()=>{
 const x=clone();x.reviews.cases[2].assignments[1]={predictedId:'item-2',referenceId:'gt-dessert',identity:'correct'};
 assert.throws(()=>evaluatePhotoBenchmark(x),/reference assigned to multiple/);
});
test('unscored guesses do not become a measured mass error',()=>{
 const x=clone();
 x.predictions.cases[0].estimate.items[0].ediblePortion={grams:null,minGrams:null,maxGrams:null,method:'not_estimable',evidence:'unknown'};
 const r=evaluatePhotoBenchmark(x);
 assert.equal(r.metrics.scoredWeights,1);
 assert.equal(r.metrics.weightAbstentionRate,0.4);
 assert.equal(r.metrics.gramMAE,15);
});
test('visible items missed by the Agent count against identification recall',()=>{
 const x=clone();x.references.cases[0].referenceItems.push({id:'gt-beans',name:'beans',grams:70,visible:true});
 const r=evaluatePhotoBenchmark(x);
 assert.equal(r.metrics.visibleReferenceItems,5);
 assert.equal(r.metrics.identificationRecall,0.6);
});
test('wrong food identity is not credited with a correct mass estimate',()=>{
 const x=clone();x.predictions.cases[1].estimate.items[0].ediblePortion.grams=320;
 const r=evaluatePhotoBenchmark(x);
 assert.equal(r.metrics.scoredWeights,2);
 assert.equal(r.metrics.wrongItems,1);
});
test('benchmark rejects missing provenance and claims of non-blind evaluations',()=>{
 const x=clone();x.predictions.run.referencesHiddenFromAgent=false;
 assert.throws(()=>evaluatePhotoBenchmark(x),/blind reference isolation/);
 const y=clone();y.predictions.run.modelId='';
 assert.throws(()=>evaluatePhotoBenchmark(y),/modelId/);
});
test('CLI uses canonical PhotoEstimateV1 schema and flags synthetic fixtures',()=>{
 const cli=path.resolve(directory,'../../audit/eval-photo-estimates.mjs');
 const r=spawnSync(process.execPath,[cli,'--example'],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 assert.match(r.stderr,/SYNTHETIC/);
 assert.equal(JSON.parse(r.stdout).metrics.scoredWeights,2);
});

test('CLI rejects model-produced calories using the runtime PhotoEstimate schema',()=>{
 const x=clone(),dir=mkdtempSync(path.join(os.tmpdir(),'photo-bench-schema-'));
 try {
   x.predictions.cases[0].estimate.items[0].calories=250;
   const pred=path.join(dir,'predictions.json');fs.writeFileSync(pred,JSON.stringify(x.predictions));
   const cli=path.resolve(directory,'../../audit/eval-photo-estimates.mjs');
   const r=spawnSync(process.execPath,[cli,'--references',path.join(directory,'references.json'),'--predictions',pred,'--reviews',path.join(directory,'reviews.json')],{encoding:'utf8'});
   assert.equal(r.status,1);assert.match(r.stderr,/invalid PhotoEstimateV1/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

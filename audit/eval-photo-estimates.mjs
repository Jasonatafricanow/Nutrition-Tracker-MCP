#!/usr/bin/env node
/** A deterministic, offline, privacy-preserving benchmark scorer. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {photoEstimateSchema} from '../photo-estimation.js';
import {evaluatePhotoBenchmark} from './photo-benchmark-core.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const example=path.resolve(here,'../benchmark/examples');
function arg(name,fallback){const i=process.argv.indexOf(name);if(i===-1)return fallback;if(i+1>=process.argv.length)throw Error(`${name} needs a value`);return process.argv[i+1];}
const isExample=process.argv.includes('--example');
const files={references:arg('--references',isExample?path.join(example,'references.json'):null),predictions:arg('--predictions',isExample?path.join(example,'predictions.json'):null),reviews:arg('--reviews',isExample?path.join(example,'reviews.json'):null)};
if(Object.values(files).some(x=>!x)){
  console.error('Usage: node audit/eval-photo-estimates.mjs --references refs.json --predictions predictions.json --reviews reviews.json [--output report.json]\nOr: node audit/eval-photo-estimates.mjs --example');
  process.exit(2);
}
try{
  const documents=Object.fromEntries(Object.entries(files).map(([k,p])=>[k,JSON.parse(fs.readFileSync(p,'utf8'))]));
  for (const p of documents.predictions.cases || []) {
    const checked = photoEstimateSchema.safeParse(p.estimate);
    if (!checked.success) throw Error(`case ${p.caseId}: invalid PhotoEstimateV1: ${checked.error.issues.map(i=>i.path.join('.')+': '+i.message).join('; ')}`);
  }
  const report=evaluatePhotoBenchmark(documents);
  const target=arg('--output',null);
  if(target){fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');console.log(`Saved: ${target}`);}
  console.log(JSON.stringify(report,null,2));
  if(report.datasetKind==='synthetic') console.error('WARNING: SYNTHETIC DATA; NOT a vision model validation.');
} catch(e){console.error('Benchmark rejected:',e.message);process.exitCode=1;}

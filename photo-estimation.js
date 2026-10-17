/**
 * Vision-agent -> nutrition engine boundary.
 * A prompt cannot measure food mass. This protocol records bounded hypotheses,
 * visible evidence and unknowns for explicit downstream review.
 */
import { z } from 'zod';

export const PHOTO_ESTIMATE_VERSION = 'nutrition.photo_estimate.v1';
const gram = z.number().finite().positive().max(5000);
const portionSchema = z.object({
  grams: gram.nullable(),
  minGrams: gram.nullable(),
  maxGrams: gram.nullable(),
  method: z.enum(['reference_object','container_geometry','visual_only','user_provided','not_estimable']),
  evidence: z.string().trim().min(4).max(500)
}).strict().superRefine((p, ctx) => {
  const blank = p.grams===null || p.minGrams===null || p.maxGrams===null;
  if (p.method === 'not_estimable') {
    if (!blank || p.grams!==null || p.minGrams!==null || p.maxGrams!==null) ctx.addIssue({code:'custom',message:'not_estimable must have null mass and bounds'});
  } else if (blank) {
    ctx.addIssue({code:'custom',message:'estimated mass requires grams, minGrams, maxGrams'});
  } else if (!(p.minGrams <= p.grams && p.grams <= p.maxGrams)) {
    ctx.addIssue({code:'custom',message:'mass must lie within estimated bounds'});
  } else if (p.method!=='user_provided' && p.minGrams===p.maxGrams) {
    ctx.addIssue({code:'custom',message:'visual estimation cannot claim zero uncertainty'});
  }
});
const itemSchema = z.object({
  id: z.string().regex(/^item-[1-9][0-9]*$/),
  predictedName: z.string().trim().min(1).max(100),
  foodState: z.enum(['raw','cooked','packaged','mixed','unknown']),
  identificationConfidence: z.enum(['low','medium','high']),
  visibleEvidence: z.array(z.string().trim().min(3).max(300)).min(1).max(8),
  alternativeNames: z.array(z.string().trim().min(1).max(100)).max(5),
  ediblePortion: portionSchema,
  obscured: z.boolean()
}).strict();
export const photoEstimateSchema = z.object({
  schemaVersion: z.literal(PHOTO_ESTIMATE_VERSION),
  imageAssessment: z.object({
    view: z.enum(['top_down','oblique','side','multiple','unknown']),
    scaleReference: z.enum(['known_size','unverified_plate','none']),
    limitations: z.array(z.string().trim().min(3).max(300)).max(12)
  }).strict(),
  items: z.array(itemSchema).min(1).max(20),
  hiddenOrUnquantified: z.array(z.string().trim().min(2).max(180)).max(12),
  questions: z.array(z.string().trim().min(2).max(240)).max(12),
  coverage: z.enum(['full_visible_plate','partial_or_obscured'])
}).strict().superRefine((v,ctx)=>{
  const ids = new Set();
  for (let i=0;i<v.items.length;i++) {
    const item=v.items[i];
    if (ids.has(item.id)) ctx.addIssue({code:'custom',path:['items',i,'id'],message:'duplicate item id'});
    ids.add(item.id);
    if (['reference_object','container_geometry'].includes(item.ediblePortion.method) && v.imageAssessment.scaleReference!=='known_size')
      ctx.addIssue({code:'custom',path:['items',i,'ediblePortion','method'],message:'size-referenced methods need independently known dimensions'});
    if (item.ediblePortion.method==='user_provided' && item.visibleEvidence.every(e=>!e.includes('用户')&&!e.toLowerCase().includes('user')))
      ctx.addIssue({code:'custom',path:['items',i,'ediblePortion','method'],message:'user_provided requires explicit user-supplied evidence'});
    if (item.ediblePortion.method==='visual_only' && v.imageAssessment.scaleReference==='none' && item.identificationConfidence==='high') {
      // Name may be obvious despite unknown scale; identification confidence is not mass confidence.
      // Do not reject the item; callers must still review weight bounds.
    }
  }
});

export const PHOTO_ESTIMATE_EXAMPLE = {
  schemaVersion: PHOTO_ESTIMATE_VERSION,
  imageAssessment: { view:'oblique',scaleReference:'unverified_plate',limitations:['Plate diameter not measured','Oil mixed into food is not visible'] },
  items: [
    {id:'item-1',predictedName:'熟白米饭',foodState:'cooked',identificationConfidence:'high',
     visibleEvidence:['Visible white grains formed in one mound'],alternativeNames:[],obscured:false,
     ediblePortion:{grams:180,minGrams:120,maxGrams:260,method:'visual_only',evidence:'Mound occupies about one third of plate; vessel size unverified'}},
    {id:'item-2',predictedName:'鸡肉（做法待确认）',foodState:'cooked',identificationConfidence:'medium',
     visibleEvidence:['Several pale slices with browned edges'],alternativeNames:['鱼肉','豆制品'],obscured:true,
     ediblePortion:{grams:null,minGrams:null,maxGrams:null,method:'not_estimable',evidence:'Most of the portion is behind rice'}}
  ],
  hiddenOrUnquantified:['Cooking oil, dressings and sauces cannot be quantified from this photograph'],
  questions:['鸡肉还是鱼肉？','米饭约一小碗还是一大碗？','有多少额外加的油或酱汁？'],
  coverage:'partial_or_obscured'
};

export const PHOTO_ESTIMATION_PROMPT = `You are compiling a meal photograph into the strict nutrition.photo_estimate.v1 intermediate representation for a downstream MCP nutrition engine. You are a visual estimator, NOT a scale or a nutrition database. The photograph is supplied in the current user turn, not by the MCP tool.

TASK (in order):
1. OBSERVE without guessing: divide *visible edible food* into distinct items. Describe visual evidence (color, texture, boundaries, container geometry, visible count) for each item. Determine raw vs cooked vs mixed vs uncertain. Do not claim unseen ingredients are visible.
2. IDENTIFY: predict the most defensible food type and plausible alternatives. Food identification confidence must not imply confidence in its weight. If uncertain, use a broader name and low confidence.
3. ESTIMATE EDIBLE PORTION IN GRAMS, not just the object name. Estimate count and 3D geometry first. If (and ONLY if) independently known dimensions exist, estimate edible volume (cm^3) × a defensible preparation-specific bulk density (g/cm^3) to derive grams. If geometry or density is unknown, use visually plausible broad serving-size ranges rather than invented dimensions or densities. Exclude inedible bones/shells. Distinguish cooked vs raw mass; do not silently transfer one to the other. For shared dishes or leftovers, estimate the consumed fraction ONLY if supplied by the user. Do not assume plate/bowl diameter: a standard-looking plate is NOT a known-size reference. Choose a method: user_provided (actual size/amount supplied in conversation), reference_object (independently known dimensions), container_geometry (only when container dimensions are known), visual_only (rough unconstrained visual estimate), or not_estimable (null grams and bounds). For visual-only guesses ALWAYS supply a broad plausible min/central/max range; min<max, central within range. If the image lacks scale, no fabricated precise grams or measured wording. If mass cannot be meaningfully bounded, use null. Never label model guesses as measured.
4. UNCERTAINTY AND COVERAGE: flag occluded or out-of-frame food, cooking oil, sauces, fillings, dressings, drinks, plate leftovers and whether the photo represents the entire consumed portion. List *concrete* follow-up questions only for decision-changing ambiguities (usually 1-3).
5. EMIT ONLY a JSON object matching the contract below. Every key is required, no extra keys, no markdown, no calories, no foodId, no invented macros. Food library matching is done by search_foods AFTER this compilation. The MCP engine will validate the structure and ask for confirmation before booking into the diet ledger.

schemaVersion = "nutrition.photo_estimate.v1".
imageAssessment: {view: "top_down"|"oblique"|"side"|"multiple"|"unknown", scaleReference: "known_size"|"unverified_plate"|"none", limitations: string[]}.
items: [{id: "item-1",predictedName:string,foodState:"raw"|"cooked"|"packaged"|"mixed"|"unknown",identificationConfidence:"low"|"medium"|"high",visibleEvidence:string[],alternativeNames:string[],ediblePortion:{grams:number|null,minGrams:number|null,maxGrams:number|null,method:"reference_object"|"container_geometry"|"visual_only"|"user_provided"|"not_estimable",evidence:string},obscured:boolean}].
hiddenOrUnquantified: string[]. questions: string[]. coverage: "full_visible_plate"|"partial_or_obscured".

CRITICAL: Do not output nutritional values from visual imagination. Do not silently equate visible food with the entire consumed meal. A machine-readable estimate is still only an estimate, not measured truth.

Example (illustration, never copy its food guesses into a different image):\n${JSON.stringify(PHOTO_ESTIMATE_EXAMPLE,null,2)}`;

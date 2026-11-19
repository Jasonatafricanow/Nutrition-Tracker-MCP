/**
 * Everyday Agent product contract.
 *
 * Six read intents and eleven write intents (recipes/meal plans added 2026-11-15). This file is a thin,
 * deterministic routing adapter over the existing source-of-truth engine:
 * no new calculator, tables, health inference or photo shortcut.
 *
 * Legacy compact and full interfaces remain selectable for migration.
 */
export const EVERYDAY_READS = Object.freeze(['summary', 'meals', 'foods', 'recipes', 'plan', 'shopping']);
export const EVERYDAY_WRITES = Object.freeze(['meal', 'correct', 'health', 'photo_stage', 'photo_confirm', 'photo_discard', 'recipe_save', 'plan_set', 'plan_remove', 'plan_log', 'food_add']);
export const EVERYDAY_PERIODS = Object.freeze(['today', '7d', '30d']);

import { createHash } from 'node:crypto';

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// What people (and agents) call a meal → the ledger's slot names.
const SLOT_ALIASES = {夜宵:'加餐',宵夜:'加餐',零食:'加餐',下午茶:'加餐',点心:'加餐',snack:'加餐',
  breakfast:'早餐',lunch:'午餐',dinner:'晚餐',supper:'晚餐',早饭:'早餐',午饭:'午餐',晚饭:'晚餐'};
const slot = value => typeof value === 'string' ? (SLOT_ALIASES[value.trim().toLowerCase()] ?? SLOT_ALIASES[value.trim()] ?? value) : value;

// A write without requestId gets one from its own content: the same call retried is the same request,
// so the engine's idempotency still holds; a different call is a different request.
function withRequestId(memberId, operation, args) {
  if (args.requestId || !['meal','correct','photo_stage','photo_confirm','plan_log','recipe_save'].includes(operation)) return args;
  const digest = createHash('sha256').update(JSON.stringify([memberId ?? null, operation, args])).digest('hex').slice(0, 24);
  return {...args, requestId: `auto-${operation}-${digest}`};
}

export function createEverydayInterface(compact) {
  if (!compact || typeof compact.query !== 'function' || typeof compact.execute !== 'function') {
    throw new Error('existing compact nutrition engine adapter required');
  }

  async function query({view='summary',memberId,period='today',focus='daily',date,queries,limit=5,query:term='',recipeId,fromDate,toDate,includeLogged=false}={}) {
    if (!EVERYDAY_READS.includes(view)) throw new Error('Unsupported everyday read; use MCP_TOOL_SURFACE=compact for advanced reads');
    if (view === 'summary') {
      if (!EVERYDAY_PERIODS.includes(period)) throw new Error('period must be today, 7d or 30d');
      if (period !== 'today') {
        // The underlying report intentionally treats days without entries
        // as UNKNOWN rather than zero. Never interpolate missing days.
        return compact.query({view:'report',memberId,days:period === '7d' ? 7 : 30});
      }
      if (!['daily','food','health'].includes(focus)) throw new Error('focus must be daily, food or health');
      return compact.query({view:memberId ? 'member' : 'household',memberId,focus});
    }
    if (view === 'meals') {
      if (period !== 'today') throw new Error('Use a specific date for meals, or summary for a 7/30 day report');
      return compact.query({view:'meals',memberId,date});
    }
    if (view === 'recipes') {
      return compact.query({view:'recipes',memberId,recipeId,query:term,limit});
    }
    if (view === 'plan' || view === 'shopping') {
      // Planning reads may look ahead; they never write and never claim intake.
      return compact.query({view:view === 'plan' ? 'meal_plan' : 'shopping_list',memberId,
        fromDate:fromDate ?? date,toDate,includeLogged});
    }
    if (!Array.isArray(queries) || queries.length < 1 || queries.length > 6) {
      throw new Error('foods requires 1–6 text queries');
    }
    return compact.query({view:'foods',memberId,queries,limit,source:'local'});
  }

  function execute({memberId,operation,args={},includeContext=true}={}) {
    if (!EVERYDAY_WRITES.includes(operation)) {
      throw new Error('Unsupported everyday write; use MCP_TOOL_SURFACE=compact for advanced operations');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('args must be an object');
    }
    if (own(args, 'mealSlot')) args = {...args, mealSlot: slot(args.mealSlot)};
    args = withRequestId(memberId, operation, args);
    if (operation === 'meal') {
      // One user intent, two provenance/precision modes. The underlying
      // engine still validates exact food IDs, macros and idempotency.
      const source = args.source ?? 'text';
      if (!['text','measured'].includes(source)) {
        throw new Error('meal source must be text or measured; images require photo_stage + photo_confirm');
      }
      const {source:_, ...payload} = args;
      if (source === 'text') {
        return compact.execute({memberId,operation:'quick_meal',args:{...payload,source:'text'},includeContext});
      }
      return compact.execute({memberId,operation:'meal',args:payload,includeContext});
    }
    if (operation === 'correct') {
      // The caller supplies a known ID if available, otherwise the engine
      // resolves a recent meal from foodName/date/slot; ambiguity fails closed.
      if (own(args,'mealId')) {
        return compact.execute({memberId,operation:'correction',args,includeContext});
      }
      if (!args.foodName) throw new Error('Correction requires mealId or foodName');
      return compact.execute({memberId,operation:'recent_correction',args,includeContext});
    }
    if (operation === 'health') {
      // Household clinical/symptom observations remain specialist facts,
      // not diagnoses. Other health readings go through the old checkin.
      const mapped = args.kind ? 'health_observation' : 'checkin';
      return compact.execute({memberId,operation:mapped,args,includeContext});
    }
    if (operation === 'photo_stage') {
      // A staged photograph is a DRAFT; no meal ledger write occurs here.
      return compact.execute({memberId,operation:'photo_stage',args,includeContext:false});
    }
    if (operation === 'photo_discard') {
      // Close only one specified unconfirmed draft. The engine refuses
      // booked meals, is idempotent for already-discarded drafts, and
      // never writes or deletes ledger entries.
      if (own(args,'draftIds') || Array.isArray(args.draftId)) {
        throw new Error('photo_discard closes one specified draft only');
      }
      if (!args.draftId || typeof args.draftId !== 'string') {
        throw new Error('photo_discard requires draftId');
      }
      return compact.execute({memberId,operation:'photo_discard',args:{draftId:args.draftId},includeContext:false});
    }
    if (operation === 'recipe_save') {
      // Ingredients must be real local food IDs; engine computes nutrition.
      return compact.execute({memberId,operation:'recipe_save',args,includeContext:false});
    }
    if (operation === 'plan_set' || operation === 'plan_remove') {
      return compact.execute({memberId,operation,args,includeContext:false});
    }
    if (operation === 'plan_log') {
      // Books one plan entry through the existing meal transaction, split by
      // per-serving ingredient grams. Future dates are refused by the engine.
      if (!args.entryId || !args.requestId) throw new Error('plan_log requires entryId and requestId');
      return compact.execute({memberId,operation:'plan_log',args,includeContext});
    }
    if (operation === 'food_add') {
      // Guarded library growth: the engine searches for similar foods first and
      // refuses until every candidate was reviewed and declared distinct.
      const {dataSource,source:_s,...rest} = args;
      if (!dataSource) throw new Error('food_add requires dataSource (where the per-100g numbers come from)');
      return compact.execute({memberId,operation:'food_add_checked',args:{...rest,source:dataSource},includeContext:false});
    }
    if (operation === 'photo_confirm') {
      // No path from image directly to meal/text. Engine verifies explicit
      // user confirmation evidence and all candidate decisions before write.
      return compact.execute({memberId,operation:'photo_confirm',args,includeContext});
    }
    throw new Error('Unsupported everyday write; use MCP_TOOL_SURFACE=compact for advanced operations');
  }
  return {query,execute};
}

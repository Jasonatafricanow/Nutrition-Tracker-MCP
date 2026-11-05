/**
 * Everyday Agent product contract.
 *
 * Exactly three read intents and five write intents. This file is a thin,
 * deterministic routing adapter over the existing source-of-truth engine:
 * no new calculator, tables, health inference or photo shortcut.
 *
 * Legacy compact and full interfaces remain selectable for migration.
 */
export const EVERYDAY_READS = Object.freeze(['summary', 'meals', 'foods']);
export const EVERYDAY_WRITES = Object.freeze(['meal', 'correct', 'health', 'photo_stage', 'photo_confirm']);
export const EVERYDAY_PERIODS = Object.freeze(['today', '7d', '30d']);

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export function createEverydayInterface(compact) {
  if (!compact || typeof compact.query !== 'function' || typeof compact.execute !== 'function') {
    throw new Error('existing compact nutrition engine adapter required');
  }

  async function query({view='summary',memberId,period='today',focus='daily',date,queries,limit=5}={}) {
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
        if (!own(args,'expectedRevision')) throw new Error('An identified correction requires expectedRevision');
        return compact.execute({memberId,operation:'correction',args,includeContext});
      }
      if (!args.foodName) throw new Error('Correction requires mealId+expectedRevision or foodName');
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
    // No path from image directly to meal/text. Engine verifies explicit
    // user confirmation evidence and all candidate decisions before write.
    return compact.execute({memberId,operation:'photo_confirm',args,includeContext});
  }
  return {query,execute};
}

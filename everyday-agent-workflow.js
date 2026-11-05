/** Default low-surface workflow. Read only when the conversation calls for it.
 * Other capabilities are intentionally absent from ordinary Agent tool discovery.
 */
export const EVERYDAY_AGENT_WORKFLOW = [
 'Nutrition Tracker everyday contract: TWO MCP tools with THREE read intents and FIVE write intents.',
 'The Agent handles dialog understanding and source-aware estimates; Nutrition stores validated records and audit.',
 'READ: nutrition_query(view="summary",memberId?,period="today"|"7d"|"30d",focus="daily"|"food"|"health").',
 'READ: nutrition_query(view="meals",memberId?,date?) to locate an existing record before a nonrecent correction.',
 'READ: nutrition_query(view="foods",memberId?,queries=["rice","chicken"]) looks up 1-6 verified LOCAL food IDs.',
 'WRITE: nutrition_execute(operation="meal",memberId?,args={mealSlot,source:"text",requestId,items:[{name,weightGrams,foodId? OR p/c/f}]}).',
 '  For explicit weighed/food-library measurements, use source:"measured" and real foodId-based items. The adapter chooses the existing strict engine path.',
 '  For text descriptions: complete in one user turn when safe; estimates stay labeled as estimates. Never invent foodIds or measured nutrients.',
 '  Images MUST NOT enter the text/measured meal route. For images use the existing estimate_meal_photo MCP Prompt, stage a source-backed photo estimate, then show ONE concise food/portion preview.',
 'WRITE: nutrition_execute(operation="photo_stage",args={mealSlot,estimate,matches?}) saves ONLY a draft.',
 '  After clear user approval, call nutrition_execute(operation="photo_confirm",args={draftId,confirmed:true,confirmationEvidence,requestId,decisions}).',
 '  No photo log before approval; do not ask the user to approve each individual JSON candidate. Incorrect identity deserves clarification.',
 'WRITE: nutrition_execute(operation="correct",args={foodName,weightGrams,requestId}) corrects an unambiguous recent item.',
 '  For known older records use args={mealId,expectedRevision,weightGrams,requestId}; on ambiguity, locate via meals and ask only about material uncertainty.',
 'WRITE: nutrition_execute(operation="health",args={sleepHours?,scaleWeightKg?,rhrBpm?,...}) for user stated measures; kind-based household observations are supported but are not diagnoses.',
 '  Device batches continue through the authenticated health webhook, not through chat tool loops.',
 'No automatic TDEE recalibration, training-plan changes, supplement advice or whole-day completeness claims from a single recorded meal.',
 'For professional nutrition editing, exports, barcode or recipe management, explain that these are outside the everyday API. Do not guess hidden operations or change deployment settings yourself; an administrator may separately opt into the compatibility or professional surface.',
 'Household memberId is attribution within a trusted family deployment, NOT an access credential. Never leak unrelated member records.',
 'Short write responses already contain updated context; do not query again without a reason.'
].join('\n');

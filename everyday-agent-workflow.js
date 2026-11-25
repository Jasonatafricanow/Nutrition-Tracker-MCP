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
 'Short write responses already contain updated context; do not query again without a reason.',
 '',
 'HOUSEHOLD INVENTORY (two extra tools, same everyday contract): inventory_query + inventory_update.',
 'READ: inventory_query(view="current") before proposing menus or shopping lists; view="availability",names=[...] checks specific foods; view="expiring" lists foods to use first; view="item",name="黄瓜" shows purchase batches.',
 'WRITE: inventory_update(operation="purchase",name,quantity?,quantityNote?,purchasedAt?,storage?,source="receipt"|"user_text",requestId) for food the user ACTUALLY bought (receipt OCR or spoken). Receipt "黄瓜600g" + user "实际是四根" => quantity:"600g", quantityNote:"实际是四根" on the SAME batch; never convert units.',
 'WRITE: operation="consume" ONLY after the user says cooking actually happened ("用了两根黄瓜" => usedQuantity:"两根"; "还剩半斤" => remainingQuantity:"半斤"). operation="discard" for user-reported spoilage. operation="adjust" applies user corrections and OVERRIDES Agent inference. operation="update_condition" for storage/opened/cut/package expiry.',
 'Use the user-reported remainder when available. The tool can infer an approximate remainder in the same unit and defaults to the oldest active batch when no batch is specified. Provide storageChangedAt only if the actual change date is known.',
 'A suggested menu, an accepted menu, or "not enough cucumber" NEVER deducts stock. Do not ask the user to weigh food or confirm every item; unknown amounts stay unknown. Freshness output is a prioritization estimate, not a food-safety verdict.',
 'Nutrition intake stays with nutrition_execute(operation="meal"); inventory writes never log meals. After a real cooking report, update inventory AND (when the user wants tracking) record the meal with the existing nutrition intent.'
].join('\n');

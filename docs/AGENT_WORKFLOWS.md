# Agent-first MCP workflows (experimental)

This repository is an MCP nutrition-tool module. **The conversation with an AI Agent is the primary interface**; `viewport.html` is a read-only-first dashboard for monitoring and reviewing state. There is no embedded LLM. Tools are registered from the same `TOOL_DEFS` schema into the stdio MCP server.

## Normal agent session

1. `get_agent_context({})` for a lightweight daily budget and last logged meals. Use `get_snapshot({})` only if detailed planning/diagnostics are needed.
2. For a new food, `search_foods({ "query": "rice" })` / use Chinese food names if present. Inspect per-100g values, whether a food is raw/cooked, and ask user to confirm **grams**; if no database match exists, obtain reliable macros or ask user before passing explicit values.
3. `log_meal_items({ "mealSlot": "午餐", "items": [{ "foodId": "f7", "weightGrams": 150 }], "requestId": "stable-on-retry-only" })`.
4. Use `get_meal_history({ "date": "YYYY-MM-DD" })` to confirm actual storage. The returned meal IDs may be passed to `delete_meal_item` if correction is needed.
5. Only after the user confirms a day is fully recorded, call `mark_intake_complete` (never automatically on the first meal).

## Save and reuse a known meal

```json
{"tool":"save_meal_template","args":{"name":"Office lunch","mealSlot":"午餐","date":"2026-10-16"}}
{"tool":"list_meal_templates","args":{"query":"office","limit":5}}
{"tool":"log_meal_template","args":{"templateId":"<returned templateId>","mealSlot":"午餐","multiplier":1,"requestId":"new-confirmed-meal-456"}}
```

Template items are snapshots of actual logged food macros and masses. They deliberately do **not** inherit future edits to the ingredient library. A multiplier scales the original saved total; it is **not** a claim that the portions were measured again.

## Backfill and export

```json
{"tool":"get_meal_history","args":{"date":"2026-10-16"}}
{"tool":"export_nutrition_data","args":{"fromDate":"2026-10-01","toDate":"2026-10-17"}}
```

The export is JSON returned to the MCP client. It includes sensitive health and dietary records and should be kept in the user's trusted context. The endpoint bounds requests at 90 days; the tool does not write to cloud storage or create a public URL.

## Trust boundaries

- Input amount, food type and preparation state must be confirmed; a language model's guess is **not a measured dietary record**.
- The backend computes P/C/F and caloric totals, and all writes are stored in SQLite.
- `requestId` prevents duplicate meals on replay caused by retries. Use one unique ID per confirmed operation; a duplicate with changed content is rejected.
- History edits intentionally reset `intake_complete`. `calibrate_metabolic_tdee` is still preview-only until an explicit `apply:true`.
- This experimental branch has not undergone longitudinal human validation. The TDEE and recovery models remain heuristics.

## Photo-to-meal workflow (external vision Agent + MCP)

Photo understanding is **not** a raw image-to-calories operation. Obtain the MCP prompt `estimate_meal_photo` (or invoke `get_photo_estimation_protocol` if the host cannot list prompts), and feed it the photograph already present in the Agent conversation. Its output is a strictly validated `nutrition.photo_estimate.v1` artifact: visual evidence, food hypotheses, edible mass with plausible bounds, explicit unknowns, and questions.

1. Run the vision prompt; do not submit a plain caption or invented exact grams.
2. Call `search_foods` for the candidate food identities. Verify preparation state; do not invent a `foodId` or macros.
3. Call `stage_photo_estimate({mealSlot, estimate, matches})`. A draft is persisted but **not** logged as eaten.
4. Briefly present the inferred food list, gram intervals and unknown sauces/oils to the user. Ask the smallest necessary clarifying question(s).
5. After approval, call `confirm_photo_meal({draftId, confirmed:true, requestId, decisions:[...]})` and record each reviewed item's portion source (`visual_estimate`, `user_estimate`, `measured`). Omit unknown components only when the user explicitly accepts a partial record.
6. `get_meal_history` verifies the commit. Never automatically mark the whole day as intake-complete.

See [PHOTO_ESTIMATION_PROTOCOL.md](PHOTO_ESTIMATION_PROTOCOL.md) for the exact compiler contract and worked tool call. MCP is the primary UX; the dashboard is intentionally not involved in this workflow.

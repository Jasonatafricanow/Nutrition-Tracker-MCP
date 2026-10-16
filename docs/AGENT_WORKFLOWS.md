# Agent-first MCP workflow reference (experiment)

This project is **an MCP module for AI Agents**, not a dashboard-driven app. The user speaks to an Agent; the Agent asks clarifying questions and calls backend tools; the SQLite engine performs deterministic calculations and persistence. The HTML dashboard is only a readout/review surface.

## Recommended Agent sequence

1. Call `get_agent_context({})` to obtain a compact current state (not the whole sensitive `get_snapshot` payload).
2. Search foods using `search_foods({ "query": "米饭", "limit": 10 })`. Confirm preparation state (raw vs cooked), weight, and the intended date with the user. Do not silently guess.
3. Record after confirmation with `log_meal_items({ "mealSlot": "午餐", "items": [{ "foodId": "f7", "weightGrams": 150 }], "requestId": "unique-confirmed-action-123" })`.
4. A stable `requestId` protects **retries of the same action only**. For another meal—even with identical food—use a new ID. Reusing an ID with changed inputs is an error.
5. Check the ledger using `get_meal_history({ "date": "2026-10-17" })`. Use meal IDs for corrections via `delete_meal_item`; deleting or adding meals resets that day's intake-complete status.
6. Call `mark_intake_complete` only when the user explicitly indicates **all meals for that day** have been recorded.

## Reusable meal templates

```json
{"tool":"save_meal_template","args":{"name":"Office lunch","mealSlot":"午餐","date":"2026-10-16"}}
{"tool":"list_meal_templates","args":{"query":"Office","limit":5}}
{"tool":"log_meal_template","args":{"templateId":"<returned ID>","mealSlot":"午餐","multiplier":1,"requestId":"another-unique-confirmed-operation"}}
```

A template snapshots an **already-recorded** meal's names, weights, proteins, carbs and fats. This deliberately does not reflect later edits to food-library values; it also does not mean today's consumption has been measured. Ask the user to confirm whether this time's portions are the same.

## Backfill and export

```json
{"tool":"get_meal_history","args":{"date":"2026-10-16"}}
{"tool":"export_nutrition_data","args":{"fromDate":"2026-10-01","toDate":"2026-10-17"}}
```

Export returns structured JSON via MCP only, not a public download URL. It can include health-related personal information and is restricted to 90 calendar days per request.

## Model and privacy boundaries

The engine has no embedded LLM, no automated food photo interpretation and no calorie guessing from chat prose. The Agent must clarify unknown preparation/portion details. The TDEE estimation remains **preview-only by default** and should not be automatically applied. This experimental branch is not a clinically validated nutrition service. Keep the local HTTP server bound to loopback by default.
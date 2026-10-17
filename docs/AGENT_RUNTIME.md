# Agent-first MCP runtime: integration notes (alpha.3)

**The agent host owns perception, intent and user-facing confirmation.** This module owns deterministic nutrition calculations, schema validation, SQLite writes and audit logs. The web dashboard is only an observer.

## Discovering the workflow

For hosts with MCP Prompts support, request `nutrition_agent_workflow`. For hosts without this feature, call `get_agent_workflow` (returns the identical rules). The existing `estimate_meal_photo` prompt is a narrower sub-protocol that compiles the photo into `nutrition.photo_estimate.v1`.

Prompt discovery is **not automatic execution**. An MCP server cannot force a host to view attachments or inject instructions into the host's top-level system prompt. Configure the host to load the workflow or call the prompt on relevant turns. Vision requires a **vision-capable host**; the MCP server cannot access photos on its own.

## Text meal

1. Use `search_foods` and ask only about material missing information (food type, raw/cooked state, grams).
2. Call `log_meal_items` with a unique `requestId` stable across retries.
3. Call `get_meal_history` to verify persistence; never mark the entire day complete after only one meal.

## Photo meal

1. Run the photo compiler prompt on the user attachment, obtain the schema-constrained estimate, and `search_foods` for each likely match.
2. Call `stage_photo_estimate` to persist an **unconfirmed** draft and show uncertainty/unknown ingredients to the user.
3. After explicit approval, call `confirm_photo_meal` with `confirmed:true`, a list of **all** item decisions, and `confirmationEvidence`:

```json
{
  "draftId": "photo_FROM_STAGE",
  "confirmed": true,
  "requestId": "host-user-turn-unique",
  "confirmationEvidence": {
    "channel": "user_message",
    "summary": "User approved rice portion 180g and excluded unverified sauce",
    "reference": "optional-host-message-id"
  },
  "decisions": [
    {"index": 0, "include": true, "weightGrams": 180, "portionSource": "visual_estimate"},
    {"index": 1, "include": false}
  ]
}
```

`confirmationEvidence` records **the agent's claimed approval source**, not a cryptographic proof. Host-level confirmations cannot be verified by MCP without a host-provided trusted signal. Do not fabricate message IDs or claim approval merely because the agent successfully parsed the image.

## Correcting an already recorded food

User: *"I only ate half that rice."*

1. Read `get_meal_history` for the intended date and identify the exact `mealId`. The record has `revision` (0 on original entries).
2. Call `update_meal_item` with `{mealId, expectedRevision, requestId, weightGrams}`. An omitted food ID scales the **saved nutritional snapshot**, rather than rereading a possibly changed food library.
3. For a changed identity, provide a verified local `foodId`; for externally supplied nutrition totals, send all `p,c,f` and `nutritionSource`.
4. Read `get_meal_corrections({mealId})` if reviewing audit history. A corrected meal keeps its ID, increments revision, recalculates the day, and clears `intake_complete`.
5. If a stale revision is rejected, re-read history. Never retry with a guessed revision or a new request ID without checking the current state.

No delete+re-add is needed; the correction and audit are written within one SQLite transaction. Repeating an identical `requestId` returns the earlier result without applying a second correction.

## USDA FoodData Central: optional MCP search

Set `FDC_API_KEY` in the server environment (never in the prompt or Git repo). The additional stdio MCP tools are `search_usda_foods({query,limit})` and `get_usda_food_details({fdcId})`. They are **read-only**. Only USDA **Foundation** and **SR Legacy** records with complete per-100g protein/carbohydrate/fat in gram units are treated as usable. Branded/Survey records are not imported by this adapter.

An external result's `fdcId` is **not** a local `foodId`. A user/Agent must compare the food description, preparation state, serving basis and macro values before choosing to call the existing `add_food_to_library` with the reviewed per-100g p/c/f. Imported values are snapshots; this prototype does **not** automatically synchronize them or store the original API payload. When the API key is absent, the USDA search tool returns an explicit disabled response instead of guessing data.

USDA API docs: https://fdc.nal.usda.gov/api-guide/. Default rate limit is set by USDA; callers should avoid broad repeated searches. Dataset values, like photo guesses, still require matching to the correct food and preparation form.

## Trust and integration boundaries

- Real photo recognition accuracy is **not** implied by compiler schema tests.
- No photo binary, USDA API key, or private food history is sent to the USDA provider; only the public query or selected ID.
- Human confirmation channel is declared by the external Agent; require a host-native confirmation UX to enforce approval beyond self-report.
- A Host without Prompt support may call `get_agent_workflow` manually. MCP cannot guarantee an assistant will autonomously do so.

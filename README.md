# Nutrition Tracker MCP

**Local-first nutrition tracking, carb cycling, and adaptive calorie planning — accessible through MCP and a live web dashboard.**

Nutrition Tracker MCP is an experimental, self-hosted nutrition and training-support engine. It combines a weekly high/medium/low-carb schedule, meal and weight logs, optional recovery measurements, and bounded TDEE adjustments in a single SQLite-backed system.

You can operate it through a browser, connect an MCP-compatible AI assistant, or send measurements from a phone automation via HTTP. All three entry points use the **same calculation engine and persistent ledger**.

> **Scope:** This is a single-user, local-first tracking and planning tool, **not** an AI model, clinical metabolic test, medical device, or validated training prescription. Its readiness thresholds, glycogen/water corrections, forecasts, and TDEE adjustments are heuristics. Treat their outputs as estimates, not diagnoses or measured physiological facts.
>
> **Language:** The current web interface, food library, and many tool descriptions are in Simplified Chinese.

## What it does

- **Weekly carb cycling:** Distributes carbohydrates and fats across high-, medium-, and low-carb days while maintaining the configured *weekly average* macronutrient target and a constant daily protein allocation.
- **Adaptive calorie baseline:** Starts with the Mifflin–St Jeor BMR estimate and an activity multiplier, then allows bounded TDEE adjustments based on logged energy intake and weight trends.
- **Recovery-aware scheduling:** Accepts HRV, resting heart rate, and sleep measurements; computes a heuristic readiness score and can switch the current day to a low-carb recovery plan when a threshold is crossed. The day can subsequently be changed manually.
- **Weight-trend estimation:** Estimates a glycogen-associated water component and maintains an exponentially weighted moving average (EWMA) of the adjusted scale weight.
- **Seven-day forecast:** Shows *model-estimated* tissue-weight and scale-weight paths under the current plan. This is a projection, not a prediction validated against individuals.
- **Food and supplement logs:** Includes a small editable food library, portion-based macro calculation, meal entries, and per-day supplement check-ins.
- **Observable state:** Persists daily ledgers, TDEE calibration history, and tool-event logs in SQLite. The browser dashboard updates over Server-Sent Events (SSE).
- **Agent integration:** Exposes 10 MCP tools plus a read-only `telemetry://snapshot` resource for compatible assistants. The engine itself does not call an LLM.

## How the pieces fit together

```text
          MCP client / AI assistant
                    │ stdio
                    ▼
 Browser ── HTTP ── server.js ◄── HTTP health webhook
   ▲                │
   └────── SSE ─────┤
                    ▼
              engine.js
       targets · logs · telemetry
       trends · TDEE calibration
                    │
                    ▼
             SQLite (WAL)
```

The browser is a view and control surface; `engine.js` remains the source of truth for calculations and state transitions. Multiple MCP-launched instances can share a database file. If port `3456` is already in use, an additional instance can continue offering stdio tools without starting a second HTTP listener; the active dashboard detects cross-process database changes via SQLite `PRAGMA data_version` polling.

## Requirements

- **Node.js 22.13 or newer** (uses built-in `node:sqlite`; an experimental warning may appear on supported Node 22 builds)
- npm
- No external database server, cloud account, or API key required for the core engine

## Quick start

```bash
npm ci
npm run demo
```

Open **http://127.0.0.1:3456**.

`npm run demo` uses `macro_demo.db` and seeds sample history, meals, and a calibration preview. For your own persistent ledger, stop the demo server and run:

```bash
npm start
```

The standard database is `macro_engine.db` in the project directory. These database files are excluded by `.gitignore`.

Additional commands:

```bash
npm test          # run the Node test suite
node server.js --no-stdio  # explicitly run HTTP-only
```

**Time zone:** Dates follow the Node process's local time zone. The included date-specific tests currently assume `Asia/Shanghai`. On Linux/macOS, run `TZ=Asia/Shanghai npm test` to reproduce the 10 passing tests in that time zone; other time zones may produce two date-related failures. Production date handling and tests should be reviewed before multi-time-zone use.

## Connect an MCP client

Configure a compatible MCP client to launch the server over **stdio**. Replace the script path with the absolute path to your checkout:

```json
{
  "mcpServers": {
    "nutrition-tracker-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/nutrition-tracker-mcp/server.js"]
    }
  }
}
```

For Windows, a forward-slash path such as `C:/projects/nutrition-tracker-mcp/server.js` works in the JSON configuration. The example is a generic MCP configuration; the settings location varies by client.

When launched by an MCP client with piped standard input, the server starts the stdio transport alongside the HTTP dashboard. Running `npm start` in an interactive terminal normally starts only the HTTP interface. Tool responses contain structured JSON serialized as MCP text content.

### MCP tools

| Tool | Purpose |
| --- | --- |
| `get_snapshot` | Read the full state: profile, targets, logs, forecast, and calibration diagnostics |
| `set_profile` | Update physical parameters, activity multiplier, energy goal, and weekly P/C/F ratios |
| `log_morning_checkin` | Record optional weight, HRV, resting heart rate, sleep, steps, and active calories |
| `calibrate_metabolic_tdee` | Review recent logs and apply a bounded daily TDEE correction |
| `set_day_context` | Manually change today's carb level, training status, focus, or advice |
| `update_weekly_schedule` | Update one day or the entire seven-day carb/training template |
| `log_meal_items` | Add foods by library ID and portion size, or by directly provided macros |
| `delete_meal_item` | Remove a meal item and recalculate daily intake |
| `add_food_to_library` | Add a food with macronutrients per 100 g |
| `update_supplement_stack` | Mark a supplement as taken and optionally customize today's dose label |

**MCP resource:** `telemetry://snapshot` (JSON).

Example things to ask a connected assistant:

- “Show today's remaining calories and protein/carbohydrate/fat targets.”
- “Log 200 g of chicken breast from the food library for lunch.”
- “Change Friday to a low-carb recovery day.”
- “Summarize my seven-day weight trend and tell me whether there is enough data to attempt TDEE calibration.”

An assistant may use the tools, but **the assistant's generated advice is separate from the engine's deterministic computations**.

## HTTP API and health webhook

With the default configuration, the server listens only on loopback (`127.0.0.1:3456`).

| Route | Method | Function |
| --- | --- | --- |
| `/` | GET | Web dashboard |
| `/api/snapshot` | GET | Current JSON state |
| `/api/stream` | GET | SSE state updates |
| `/api/mcp-dispatch` | POST | Dispatch an engine tool by name and arguments |
| `/api/health-webhook` | POST | Send optional morning/health measurements |

An example webhook request:

```bash
curl -X POST http://127.0.0.1:3456/api/health-webhook \
  -H 'Content-Type: application/json' \
  -d '{"weightKg":75.2,"hrvMs":62,"rhrBpm":56,"sleepHours":7.4,"source":"phone-automation"}'
```

Supported payload fields: `weightKg` (or `scaleWeightKg`), `hrvMs`, `rhrBpm`, `sleepHours`, `deepSleepPct`, `steps`, `activeKcal`, and `source`. They are optional. A phone automation or exporter must be configured to send them; **there is no built-in Apple Health or Health Connect integration**.

Another example, manually setting today's carb level:

```bash
curl -X POST http://127.0.0.1:3456/api/mcp-dispatch \
  -H 'Content-Type: application/json' \
  -d '{"tool":"set_day_context","args":{"carbLevel":"low"}}'
```

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP bind address |
| `PORT` | `3456` | HTTP port |
| `DB_PATH` | `./macro_engine.db` relative to the script directory | SQLite file path; overrides the default demo/regular path |

**Security warning:** The current HTTP interface has **no authentication or authorization** and uses permissive CORS. Any party able to reach it can read health/food records and invoke write operations. **Do not expose it to the public internet or an untrusted network.** Changing `HOST` to `0.0.0.0` enables access from other devices, but is **not safe without additional network-level access controls and an authenticated API layer**. Even local browser access should be treated carefully because of the open CORS policy.

## Model notes

The engine implements configurable bookkeeping rules, not individualized physiological measurement.

1. **Base energy target.** Estimate BMR using Mifflin–St Jeor, multiply by the activity factor, then add the configured daily energy deficit/surplus to adaptive TDEE. The base intake is floored at `1,000 kcal/day` in code; this floor is a software constraint, **not** evidence that this amount is safe or suitable for everyone.
2. **Weekly macro allocation.** Split the base energy into P/C/F using energy factors `4/4/9 kcal/g`. Daily protein remains constant. Carb weights for high/medium/low days are `1.4/1.0/0.5`; fat weights are `0.7/1.0/1.3`. Both are normalized against the seven-day schedule to preserve weekly-average allocations, allowing for rounding.
3. **Readiness heuristic.** Combines normalized HRV (45%), resting heart rate (30%), and sleep duration (25%). A score below `55`, or a resting heart rate at least `7 bpm` above baseline, triggers the `OVERRIDE_REST` rule. It is not a validated measure of “CNS fatigue”.
4. **Weight trend.** Assumes a bounded glycogen store (`200–550 g`) and a fixed water association, then applies an EWMA with `α = 0.25` to estimated water-adjusted scale weights. Actual water balance depends on many unmodeled variables.
5. **TDEE feedback.** Compares logged intake-minus-expenditure with the observed EWMA trend. Calibration requires enough weigh-ins and meal coverage, uses a `0.35` damping factor, limits each change to `±120 kcal/day`, and bounds adjusted TDEE to `±18%` of the current formula estimate. Automatic calibration is **not** continuous; a user or tool must call `calibrate_metabolic_tdee`.

### Current limitations

- Personal experiment, **single-user** data model; no accounts or per-user isolation.
- Default profile, weekly routine, foods, and supplements are sample assumptions. Set your own profile before using it for decisions.
- A heuristic model can appear numerically precise without being physiologically accurate. Weight, recovery, and energy-expenditure estimates have **not** been externally validated.
- Calorie calibration depends heavily on consistent and accurate intake logging. Missing meals, shifting activity, fluid/sodium changes, and inconsistent weigh-in timing can bias estimates.
- Manual supplement tracking does not imply a dose is appropriate. The sample supplement list is not a safety-screened recommendation.
- Date handling follows the server's local time zone; automated tests presently assume Asia/Shanghai.
- No access controls, cloud sync, data export UI, mobile app, or native wearable connection.
- The browser currently loads fonts from Google Fonts; core calculations and SQLite storage are local.

## Project structure

```text
nutrition-tracker-mcp/
├── engine.js             # SQLite schema, rules, tool definitions, state and calculations
├── server.js             # stdio MCP + Express API + SSE + webhook
├── viewport.html         # Browser dashboard (HTML/CSS/vanilla JS)
├── test/
│   └── engine.test.js    # Node built-in test runner
├── DESIGN.md             # Visual design principles (Chinese)
├── package.json
├── package-lock.json
└── .gitignore
```

No build step or frontend framework is required.

## Development and release status

The included tests cover macro allocation, food logging, recovery overrides, weight smoothing, TDEE-calibration guardrails, scheduling, and demo seeding. They are useful regression checks, **not** a validation of the underlying physiological model or network security.

Before deploying beyond a trusted localhost environment, the priorities are authentication/CORS hardening, explicit time-zone handling and cross-time-zone tests, and better characterization of model error and missing-data behavior.

## License

**No license has been selected yet.** Add a `LICENSE` file before publishing if you intend to grant others permission to reuse, modify, or distribute the source. Do not assume the repository is open-source merely because it is public.
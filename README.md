# Nutrition Tracker MCP

A local-first, Agent-first nutrition and everyday health ledger for private personal or trusted household NAS use. The host Agent understands the conversation; Nutrition Tracker validates, records, corrects and summarizes data. No embedded LLM, no automatic diagnosis, and no requirement to track every gram.

**Default interface: 2 MCP tools, 3 read intents, 5 write intents.** The default `MCP_TOOL_SURFACE=everyday` is a *product contract*, not a generic access gateway to every underlying engine feature.

## Everyday Agent contract

| Tool | Intent | User task |
| --- | --- | --- |
| `nutrition_query` | `summary` | Today's food/health overview or observed-day 7/30-day summary |
| `nutrition_query` | `meals` | Locate an existing meal for review or correction |
| `nutrition_query` | `foods` | Find up to six foods and real local `foodId` values |
| `nutrition_execute` | `meal` | Record text-based estimate, or user-supplied measured food-ID values |
| `nutrition_execute` | `correct` | Correct recent unambiguous food by name, or identified meal by ID/revision |
| `nutrition_execute` | `health` | Record weight, sleep and similar user-stated observations |
| `nutrition_execute` | `photo_stage` | Create a food-image estimate **draft**, without ledger write |
| `nutrition_execute` | `photo_confirm` | Save a staged image estimate **only after explicit user approval** |

These are three read and five write *intents*, not eight separately discoverable MCP tools.

The canonical parameter contract, examples, member rules and source/provenance boundaries are in **[Agent contract (中文)](docs/AGENT_CONTRACT_ZH.md)**. MCP hosts that support Prompts can request `nutrition_agent_workflow` only when needed; photo work can load the narrower `estimate_meal_photo` Prompt.

## Start

Requires Node.js 22.13+ and npm.

~~~sh
npm ci
npm start
~~~

The local Dashboard is available at `http://127.0.0.1:3456` by default. A host Agent using local stdio starts `node server.js` as an MCP server. The Dashboard is secondary to conversation-based input.

For family deployments, set `HOUSEHOLD_CONFIG` and `HOUSEHOLD_DATA_DIR` and supply an explicit `memberId` for person-specific operations. `memberId` **labels the record**; it is not a separate authentication credential. See [household deployment](docs/HOUSEHOLD_LIGHTWEIGHT_ZH.md).

For remote agents, Streamable HTTP MCP is **disabled unless explicitly enabled**. The remote MCP listener has its own token, port, and host/origin restrictions; see [remote deployment and security](docs/REMOTE_MCP_DEPLOYMENT_ZH.md). The Dashboard endpoint is not the remote MCP service.

For platform-specific Agent configuration, see [installation / Agent setup](docs/INSTALL_AND_AGENT_SETUP_ZH.md).

## One explicit capability boundary

| Surface | Configuration | Intended users | Exposed operations |
| --- | --- | --- | --- |
| **everyday** (default) | `MCP_TOOL_SURFACE=everyday` | Ordinary recording and review | 2 tools, 3 read and 5 write intents |
| **compact** (migration / opt-in extended API) | `MCP_TOOL_SURFACE=compact` | Existing v5.4 Agents and explicitly advanced tasks | Same two tool names; 12 read views and 18 write operations |
| **full** (legacy / engine administration) | `MCP_TOOL_SURFACE=full` | Older clients, specialist workflows and maintenance | Original low-level engine tool catalog |

Do not select `compact` or `full` for ordinary dialogue just to expose more functionality. Switching a deployment's mode changes the tools discovered by **all clients of that MCP server instance**. For concurrent users with different needs, use deliberately separated MCP processes/configurations rather than silently switching everyone to a broad catalog.

The underlying SQLite engine, idempotent request receipts, revision history, source-attributed estimates, professional calculations and existing Dashboard/health webhook workflows remain intact. The optional specialist surface is not the default Agent product.

## Critical behavior

- Text meals can be estimated in one user turn when the request clearly asks to record. Keep estimates labeled; never invent local food IDs or measurements.
- Image meals **cannot** use the text shortcut: show one clear food/portion preview, get one user approval, then call `photo_confirm`. The service does not persist the original image.
- Corrections update the original meal with revision/audit history. Duplicate or ambiguous food matches must not silently change the wrong meal.
- Missing measurement days stay unknown. Do not present absence as zero or use approximate meal entries as proof for automatic TDEE recalibration.
- Phone/device health batches use the authenticated `/api/health-webhook`, not repeated Agent tool calls.
- Household deployments use a **trusted shared NAS credential**. A caller holding that credential may access family-member records; this is not appropriate for strangers or multi-tenant health data.

## Implementation and engineering record

- [Everyday surface reduction decision](docs/EVERYDAY_AGENT_SURFACE_ZH.md)
- [Product principles for low-friction estimates](docs/PRODUCT_STRATEGY_AGENT_FIRST_ZH.md)
- [State, correction and photo implementation (historical details)](docs/archive/README_pre_v5_5.md)
- [Photo estimation protocol](docs/PHOTO_ESTIMATION_PROTOCOL.md)
- [Engineering UI design](DESIGN.md)

The v5.4 and earlier reference documents are archived or marked **historical**. They are not the default calling instructions.

## Verification

~~~sh
npm test
~~~

Contract and regression tests cover the default MCP tool catalog, the optional compatibility profiles, member attribution, source provenance, photo confirmation, audit/versioning, idempotency, and time-zone-dependent reporting. These are correctness checks, not model-performance benchmarks.

This is a self-hosted self-observation product, not clinical advice.

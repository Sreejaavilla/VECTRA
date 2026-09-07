# CAUSALIS / VECTRA — Real Decision Engine: Design & Spec

## Context

`Resonance` currently has a working **visualization + playback scaffold** (one commit) driven
by `src/simulation/mockEngine.ts` — a deterministic stand-in that emits hand-authored
keyframes conforming to the `SimulationResult` contract in `src/simulation/types.ts`.
The UI (21 components under `src/components/simulation/`), the pure selectors, and the
playback hook are built against that contract and are considered stable.

This pass produces **only a written design and implementation plan** — no code.
It describes replacing the mock with a **real deterministic state-transition + feasibility +
multi-objective scoring + recommendation engine**, using a **hybrid abstraction**: a
domain-agnostic engine skeleton with cold-chain simulation models plugged in through
configuration. The `SimulationResult` contract is **extended** (not frozen). Both
`runSimulation(one strategy)` and `evaluateScenario(all strategies)` are public.

Success: *"I can test the consequences of a decision before making it"* — configure a
scenario, change resources/constraints/priorities, simulate multiple actions from one
shared initial state, compare the resulting futures, get an explained recommendation.
**Same scenario + inputs + strategy + seed + engineVersion ⇒ structurally identical
deterministic result** (`deepEqual`; optionally `canonicalSerialize(a) === canonicalSerialize(b)`
for strong reproducibility). "Byte-identical" is not claimed.

## Guiding rule — simulation before abstraction (from review point 9)

The abstraction layer is the design's strength and its biggest schedule risk. The build
order is **non-negotiable**:

```
REAL SIMULATION → REAL DIFFERENCES BETWEEN STRATEGIES → REAL FEASIBILITY
→ REAL RECOMMENDATION → GOOD VISUALIZATION → ANALYTICS → ABSTRACTION POLISH
```

Phase 2 below must produce a believable cold-chain simulation with visibly different
strategy trajectories **before** any generic-primitive polish. If time runs short, the
generic `ActionDefinition`/`ConstraintDefinition` schemas may stay minimal and
cold-chain-shaped; they are never allowed to block a working simulation.

## Architectural decisions (locked from Q&A)

| Decision | Choice |
|---|---|
| Deliverable this pass | Design doc + implementation plan only |
| Abstraction | **Hybrid** — generic engine (feasibility, scoring, recommendation, loop, event log, snapshots); cold-chain step models pluggable via `ScenarioConfig` |
| Contract | **Extend** `types.ts` additively — every existing field kept so current components keep working |
| Decision space | **Both** `runSimulation` and `evaluateScenario` public |

## Invariants (spec §84)

1. `SimulationResult` immutable; snapshots never mutated after creation.
2. Engine has zero React imports.
3. Visualization never computes business metrics; UI never computes outcomes.
4. Engine owns feasibility, scoring, recommendation.
5. Events are the authoritative record; stable string IDs everywhere.
6. Playback changes only `currentTime`.
7. Determinism as stated above.
8. Comparison never mutates historical runs.
9. Narrative phase is never authoritative state.
10. Route changes are explicit — no interpolation of `progress` across a route switch.

---

## Target module layout

New folders `src/domain/` and `src/engine/`. `mockEngine.ts` is retained behind a flag
during development and deleted only after the real engine passes determinism + demo tests.

```
src/
  domain/
    scenario.ts       # ScenarioConfig (extended), InitialState, SimulationConfig
    state.ts          # SimulationState (authoritative, id-keyed maps)
    metric.ts         # MetricDefinition — SINGLE SOURCE OF TRUTH (see review 5,7)
    action.ts         # ActionDefinition, Precondition, StateTransition, CostModel, ActionHandler
    constraint.ts     # ConstraintDefinition (static|trajectory), operators, ConstraintViolation
    resource.ts       # ResourceDefinition, ResourceRequirement
    objective.ts      # ObjectiveDefinition, ObjectiveContribution
    events.ts         # SimulationEvent re-export, event-class rules
  engine/
    simulator.ts          # discrete timestep loop -> immutable SimulationStep[]
    transitions.ts        # declarative StateTransition application
    feasibility.ts        # static (pre-sim) + trajectory (post-sim) + final feasibility
    metrics.ts            # per-step assembly + trajectory aggregation (final/min/max/cumulative)
    scoring.ts            # ObjectiveContribution[] -> weighted aggregate score
    candidateEvaluator.ts # enumerate declared actions, evaluate each (renamed from optimizer)
    recommendation.ts     # winner + reasons (from contributions) + tradeoffs + rejected
    sensitivity.ts        # P1 — controlled perturbation, rank drivers
    models/
      types.ts        # StepModel interface
      temperature.ts  # baseline / failureRate / recoveryRate
      exposure.ts     # cumulative exposure += max(0, T - safe) * dt
      viability.ts    # clamp(100 - exposure * degradationRate, 0, 100)
    index.ts          # runSimulation(), evaluateScenario(), SimulationOptions, EngineError, ENGINE_VERSION
  simulation/
    types.ts                  # EXTENDED contract (superset; nothing removed)
    scenarios/coldChain.ts    # real ScenarioConfig + COLD_CHAIN constants + 4 actions
    engineAdapter.ts          # engine output -> existing SimulationResult shape (derives render arrays)
    selectors.ts              # unchanged
    useSimulationPlayback.ts  # unchanged
    index.ts                  # re-export real engine; keep mock export until cutover
  components/simulation/      # small additions listed below
```

---

## Contract extensions (`src/simulation/types.ts`) — all additive

### Metric definitions — one source of truth (review 5, 7)

```ts
export type MetricDirection = 'minimize' | 'maximize';
export type MetricAggregation = 'final' | 'min' | 'max' | 'cumulative';

export interface MetricDefinition {
  id: MetricKey | string;
  direction: MetricDirection;
  aggregation: MetricAggregation;    // how the trajectory collapses to one scoring value
  normalize: { min: number; max: number };
  unit?: string;
}
```

Cold-chain bindings: `temperature → max`, `viability → min`, `exposure → cumulative`,
`delay → final`, `cost → final`. Normalization, scoring, and `MetricDelta.direction` all
read `MetricDefinition` — never the objective direction, and a metric need not be an
objective to have a defined direction.

### Constraints — static vs trajectory (review 1)

```ts
export type ConstraintOperator = '<' | '<=' | '=' | '>=' | '>' | 'available' | 'unavailable';

export interface ConstraintDefinition {
  id: string;
  type: string;
  severity: 'hard' | 'soft';
  scope: 'static' | 'trajectory';    // static = evaluated on initial state; trajectory = every step
  operator: ConstraintOperator;
  value: number | string | boolean;
  appliesTo?: MetricKey | string;    // metric key or resource id
}

export interface ConstraintViolation {
  constraintId: string;
  severity: 'hard' | 'soft';
  scope: 'static' | 'trajectory';
  actual: number | string | boolean;
  expected: number | string | boolean;
  atMinutes?: number;                // set for trajectory violations
  message: string;
}

export interface FeasibilityReport {
  strategyId: string;
  staticFeasible: boolean;
  trajectoryFeasible: boolean;       // undefined until simulated
  feasible: boolean;                 // static && trajectory
  violations: ConstraintViolation[]; // hard + soft, both scopes
}
```

### Resources, objectives, actions

```ts
export interface ResourceDefinition {
  id: string; label: string;
  kind: 'discrete' | 'consumable' | 'boolean';
  initial: number | boolean; capacity?: number; unitCost?: number;
}
export interface ResourceRequirement { resourceId: string; amount: number | boolean; }

export interface ObjectiveDefinition {
  metricId: MetricKey | string;      // references a MetricDefinition
  weight: number;                    // GLOBAL CONVENTION: weights sum to 1
}

export interface ObjectiveContribution {
  objectiveId: string;
  weight: number;
  normalizedValue: number;           // 0..1 after direction flip
  contribution: number;              // weight * normalizedValue
}

export interface Precondition {
  kind: 'constraint' | 'resource' | 'flag';
  ref: string; operator: ConstraintOperator; value?: number | string | boolean;
}
export interface StateTransition {
  target: 'entity' | 'resource' | 'route' | 'flag';
  id: string; op: 'set' | 'add' | 'route-switch' | 'allocate' | 'release';
  value?: number | string | boolean; atOffsetMinutes?: number;
}
export interface CostModel { fixed?: number; perResource?: Record<string, number>; }

// Escape hatch for domain-rich actions (review 4): declarative transitions cover
// route-switch / allocate / set-flag; `apply` handles shipment splitting, quantity
// allocation, multi-destination partitioning without a fake universal workflow language.
export type ActionHandler = (state: SimulationState, ctx: ActionContext) => TransitionResult;

export interface ActionDefinition {
  id: string; label: string;
  preconditions: Precondition[];
  resourceRequirements: ResourceRequirement[];
  transitions: StateTransition[];    // declarative, used by most actions
  apply?: ActionHandler;             // optional; runs after declarative transitions
  emittedEvents: Array<Pick<SimulationEvent,'type'|'message'|'severity'> &
    { atOffsetMinutes: number; eventClass: EventClass }>;
  costModel: CostModel;
}
```

### Recommendation + evaluation

```ts
export interface RecommendationReason {
  text: string; kind: 'objective' | 'constraint' | 'tradeoff';
  contribution?: ObjectiveContribution;   // reasons are DERIVED from scoring, not free text
}
export interface RejectedAlternative { strategyId: string; reason: string; feasible: boolean; }

export interface Recommendation {
  strategyId: string;
  score: number;
  contributions: ObjectiveContribution[]; // full breakdown that sums to `score`
  reasons: RecommendationReason[];
  tradeoffs: TradeoffRow[];
  rejectedAlternatives: RejectedAlternative[];
}

export interface ScenarioEvaluation {
  feasibleStrategies: string[];
  infeasibleStrategies: FeasibilityReport[];  // includes trajectory-infeasible strategies
  results: SimulationResult[];
  recommendation: Recommendation;
}

export interface MetricDelta {
  metric: MetricKey | string;
  before: number; after: number; delta: number;
  direction: 'better' | 'worse' | 'neutral';  // from MetricDefinition.direction
}
```

### Extensions to existing interfaces

- `ScenarioConfig`: `+ metrics: MetricDefinition[]`, `+ actions`, `+ constraints`,
  `+ objectives`, `+ resources`, `+ initialState`, `+ simulation` (timestep/duration).
- `DecisionImpact`: `+ changes?: MetricDelta[]`.
- `SimulationResult`: `+ feasibility?: FeasibilityReport`, `+ recommendation?: Recommendation`
  (set only on `evaluateScenario` results).
- `RunIdentity`: `+ engineVersion: string`, `+ schemaVersion: number`.

**Priority convention:** objective weights and `WhatIfInputs.priorities` sum to `1`
(validated `1 ± 1e-6`). Demo sliders (0–100) are normalized by their total before entering
the engine.

---

## Engine design

### Determinism & seed (review 2, 3)

```ts
export interface SimulationOptions { seed?: number }
```

```
seed = options.seed ?? deriveSeed(scenarioId, strategy, canonicalInputs, engineVersion)
```

Caller-supplied seed wins (enables reproducible alternative stochastic runs, and later
robustness sweeps); otherwise a deterministic seed is derived. `RunIdentity.seed` records
the seed actually used. All model noise draws from one `mulberry32(seed)` stream in fixed
order. No `Date.now`, no `Math.random`. `canonicalSerialize` = stable key ordering +
fixed float precision, used by the strong-reproducibility test only.

### Authoritative state (`domain/state.ts`)

```ts
interface SimulationState {
  timestamp: number;
  entities: Record<string, EntityRuntime>;   // route + progress is the ONLY position source
  facilities: Record<string, FacilityRuntime>;
  resources: Record<string, ResourceRuntime>;
  shipmentAllocations: Record<string, number>; // destinationId -> doses (review 4: hybrid split)
  exposure: number;
  metrics: StepMetrics;
  flags: Record<string, boolean | number | string>;
}
```

Render arrays (`EntityState[]`, `ResourceState[]`) are derived in the adapter, never stored.

### Discrete loop (`engine/simulator.ts`)

`Δt = scenario.simulation.timestepMinutes` (5), `duration` (120).

```
state = initialState(scenario, inputs)
for (t = 0; t <= duration; t += Δt):
  processScheduledEvents(t)            # failure at FAILURE_TIME; action events at their offsets
  applyDeclarativeTransitions(t)       # transitions.ts
  runActionHandler(t)                  # action.apply?(state, ctx) if present
  updateEntities(t)                    # advance progress; route-switch is explicit
  updateResources(t)                   # consume/release per active requirements
  runStepModels(t)                     # temperature -> exposure -> viability, declared order
  metrics = assembleMetrics(state)
  emitThresholdEvents(t)               # THRESHOLD_CROSSED when a metric crosses a constraint
  steps.push(freeze(SimulationStep))   # immutable
events = flatten+sort+dedupe(step events)   # spec §25 interval (prevStep, curStep]
```

### Two-level feasibility (`engine/feasibility.ts`) — review 1

```
STATIC (pre-simulation)
  validateInputs(inputs)              # priority sum, non-negative resources, known strategy
  validateScenario(scenario)          # referential integrity of ids
  checkStaticHardConstraints(state0)  # scope:'static' hard constraints
  checkActionPreconditions(action, state0)
  checkResourceRequirements(action, state0)
  => staticFeasible + violations[]

  if !staticFeasible: strategy EXCLUDED from simulation (spec §15), listed in
     infeasibleStrategies with staticFeasible=false

SIMULATION (only for static-feasible strategies)

TRAJECTORY (post-simulation)
  evaluateTrajectoryConstraints(steps, constraints.filter(scope:'trajectory')): ConstraintViolation[]
    # e.g. temperature must never exceed 8; viability must never fall below 30; delay <= 90
    # each violation carries atMinutes
  => trajectoryFeasible = no hard trajectory violations

FINAL feasibility = staticFeasible && trajectoryFeasible
```

A strategy can be static-feasible but become **trajectory-infeasible** (e.g. emergency
vehicle exists, but response is too slow → temperature reaches 11°C → hard temperature
constraint violated). Such a strategy still produces a `SimulationResult` (so the UI can
show *why* it failed) but is marked `feasible: false` and is not eligible to be the
recommendation. Soft trajectory violations become scoring penalties, not exclusions.

### Trajectory aggregation + scoring (`engine/metrics.ts`, `engine/scoring.ts`) — review 5, 6

Each metric collapses to one scoring value via `MetricDefinition.aggregation`
(`temperature → max`, `viability → min`, `exposure → cumulative`, `delay/cost → final`).
Then:

```
normalized_i = clamp((aggValue_i - min_i) / (max_i - min_i), 0, 1)   # flipped for 'minimize'
contribution_i = weight_i * normalized_i
score = Σ contribution_i - Σ softPenalty(violations)
```

The engine returns the full `ObjectiveContribution[]` (weight, normalizedValue,
contribution) that sums to `score`. Ties broken by action declaration order.

### Recommendation (`engine/recommendation.ts`) — review 6

`reasons` are **generated from `contributions`**, not free-form: the top-N objectives by
`contribution` become `"Safety: 0.40 × 0.91 = 0.364 (dominant driver)"`-style reasons with
the `ObjectiveContribution` attached. `tradeoffs` = existing `TradeoffRow` per strategy
from normalized objective values. `rejectedAlternatives`: static-infeasible → hard
violation message; trajectory-infeasible → `"temperature exceeded 8°C at t=63"`;
feasible-but-lower → score gap phrased from the largest adverse contribution difference.

### Decision impact (`engine/metrics.ts`) — spec §33

`DecisionImpact.changes: MetricDelta[]` = per-metric `before` (state at first decision
event) vs `after` (final state); `direction` from `MetricDefinition.direction`
(`neutral` when |delta| below a per-metric epsilon).

### `evaluateScenario` / `runSimulation` (`engine/index.ts`)

```
runSimulation(scenario, inputs, strategyId, options?) -> SimulationResult
  # one strategy; recommendation field unset; feasibility field set (static + trajectory)

evaluateScenario(scenario, inputs, options?) -> ScenarioEvaluation
  reports  = scenario.actions.map(staticFeasibility)
  results  = reports.filter(staticFeasible).map(a => runSimulation(scenario, inputs, a.id, options))
  # attach trajectory feasibility to each report from its result
  feasible = results.filter(r => r.feasibility.feasible)
  recommendation = recommend(feasible, allReports, scenario.metrics, scenario.objectives, inputs.priorities)
  return { feasibleStrategies, infeasibleStrategies, results, recommendation }
```

### Error model (`engine/index.ts`) — spec §80

`type EngineError = InvalidScenario | InvalidInput | ConstraintViolationError |
ResourceUnavailable | SimulationFailure`. Engine functions return
`{ ok: true, value } | { ok: false, error }`; the adapter throws a typed error the UI maps
to a message. No `console`, no silent failure.

---

## Cold-chain scenario module (`src/simulation/scenarios/coldChain.ts`)

Ports the inline `coldChainScenario` and model constants out of `mockEngine.ts`:

```ts
export const COLD_CHAIN = {
  baselineTemperature: 5, safeTemperature: 8, criticalTemperature: 14,
  failureRatePerMin: 0.26, recoveryRatePerMin: 0.32, degradationRate: 0.16,
  timestepMinutes: 5, durationMinutes: 120, failureTimeMinutes: 35,
};
```

- **Metrics:** `MetricDefinition[]` with the aggregations above.
- **Constraints:** static (`support-vehicle available`, `budget >= action-cost`,
  `storage-capacity >= required`) + **trajectory** (`temperature <= 8` hard,
  `viability >= 30` hard, `delay <= 90` soft).
- **Objectives:** cost / delay / risk minimize, viability maximize, weights summing to 1.
- **4 `ActionDefinition`s:** `continue`, `reroute_storage`, `emergency_interception`
  (precondition: `res-support-vehicle available`), `hybrid` (uses `apply` handler to split
  the shipment — Hospital A critical → emergency vehicle, Hospital B normal → cold storage,
  spec §22–23).
- Facilities/routes/thresholds carry over unchanged → `OperationalMap` needs no change.

---

## UI changes (small)

| Component | Change |
|---|---|
| `SimulationViewport.tsx` | Accept `evaluation?: ScenarioEvaluation`; render `RecommendationPanel` when present |
| `RecommendationPanel.tsx` | **New** — winner, `ObjectiveContribution` breakdown table, reasons, tradeoffs, rejected alternatives |
| `DecisionImpactPanel.tsx` | Render `impact.changes[]` as labelled deltas with direction arrows |
| `EventFeed` / `LiveStatePanel` | Show trajectory-constraint violations (`atMinutes`) as critical events |
| `SensitivityBars.tsx` | Wire the orphaned component to real `result.sensitivity` (P1) |
| `TradeoffMatrix.tsx` | Feed from `recommendation.tradeoffs` |
| `App.tsx` | Add "Evaluate all strategies" button → `evaluateScenario`; normalize sliders to priority weights summing to 1 |
| `src/simulation/index.ts` | Export `runSimulation`, `evaluateScenario`, `coldChainScenario`, `ENGINE_VERSION`; keep mock exports until cutover |

No changes to `selectors.ts`, `useSimulationPlayback.ts`, `OperationalMap.tsx`,
`SimulationTimeline.tsx`, `MetricChart.tsx`.

---

## Implementation phases (build order enforces the guiding rule)

1. **Contract** — extend `types.ts`; add `domain/` types (`metric.ts` first); adapter stub.
   `feat(domain): add decision primitives + extend simulation contract`.
2. **Engine core + believable simulation** — `state.ts`, `simulator.ts`, `transitions.ts`,
   `models/*`, `metrics.ts` (step assembly + aggregation), cold-chain scenario with 4
   actions incl. `hybrid` handler. Adapter produces valid `SimulationResult`. **Goal: four
   strategies show visibly different trajectories on the existing map/charts.** No new UI.
   `feat(engine): discrete timestep loop`, `feat(engine): cold-chain models`,
   `feat(sim): real cold-chain scenario with differentiated strategies`.
3. **Feasibility** — `feasibility.ts` static + `evaluateTrajectoryConstraints` +
   final feasibility. `feat(engine): two-level feasibility evaluation`.
4. **Scoring + recommendation** — `scoring.ts` (`ObjectiveContribution[]`),
   `candidateEvaluator.ts`, `recommendation.ts`, `evaluateScenario`.
   `feat(engine): weighted scoring + derived recommendation`.
5. **Integration** — swap `index.ts` to real engine, delete `mockEngine.ts`, update the 5
   tests importing it. `refactor(sim): replace mock engine with real engine`.
6. **UI** — `RecommendationPanel`, decision-impact deltas, "evaluate all" button.
   `feat(ui): recommendation panel + decision-impact deltas`.
7. **P1** — `sensitivity.ts`, wire `SensitivityBars`. `feat(analytics): decision sensitivity`.

Small commits; work on a branch off `main`; no half-integrated commits to `main` (spec §83).

---

## Testing strategy (spec §68–73) — `src/engine/__tests__/` + existing suite

- **Determinism (§68):** `runSimulation` / `evaluateScenario` twice with identical args ⇒
  `deepEqual` (event IDs, ordering, timestamps, metrics, outcome, recommendation). Strong
  check: `canonicalSerialize(a) === canonicalSerialize(b)`. Supplied `options.seed`
  reproduces a prior run exactly; omitted seed falls back to the derived seed.
- **Simulation (§69):** failure at `failureTimeMinutes`; temperature rises post-failure;
  stabilizes after intervention; viability monotonic non-increasing and bounded `[0,100]`;
  resource allocation flips `available -> allocated`; route switch → two legs, no progress
  interpolation across the switch; `DELIVERY` emitted; `hybrid` splits
  `shipmentAllocations` across two destinations.
- **Static feasibility:** `supportVehicleAvailable:false` + `emergency_interception` →
  excluded from `results`, in `infeasibleStrategies` with `staticFeasible:false` and a hard
  violation carrying correct `actual`/`expected`.
- **Trajectory feasibility (review 1):** a slow-response configuration makes
  `emergency_interception` static-feasible but produces a `temperature > 8` hard violation
  with `atMinutes` set; its result has `feasibility.feasible === false`; it is not the
  recommendation but its `SimulationResult` still exists.
- **Aggregation + scoring (review 5, 6):** `temperature` scored on `max`, `viability` on
  `min`, `exposure` on `cumulative`; `Σ contributions === score` (within epsilon);
  raising `safety` priority flips the recommendation `continue → intervention` (spec §77).
- **MetricDelta direction (review 7):** temperature `8 → 5` reports `better` even though
  temperature is not an objective.
- **Selectors (§70) & playback (§71):** existing suites must pass unchanged against real
  results.
- **Comparison (§72):** two `evaluateScenario` runs, same initial state, different
  strategies/outcomes; earlier `SimulationResult` unchanged (`Object.isFrozen` / snapshot);
  keyed by `runId`.
- **Contract:** every event has a resolved `eventClass`; `events` sorted & unique;
  `decisionImpact.before` equals step metrics at the first decision event;
  `RunIdentity.engineVersion === ENGINE_VERSION`.

## Manual demo verification (spec §74)

```bash
npm test
```

```bash
npm run dev
```

Healthy shipment → failure at t≈35 → temperature rises, viability falls → "Evaluate all
strategies" shows feasible set + recommendation with contribution breakdown → pick a
strategy → run → watch intervention + projected recovery → change one constraint (support
vehicle unavailable, **or** safety priority 20→50, **or** tighten `temperature <= 8` to
force a trajectory violation) → re-run → recommendation changes → compare both runs → replay
the original and confirm `deepEqual` via the debug overlay (`d` key).

## Out of scope this pass

AI natural-language layer (spec §78–79), seeded robustness/uncertainty sweeps (§37),
second domain (§66 P3), combinatorial/parameter-sweep search in `candidateEvaluator.ts`
(only the 4 declared actions are enumerated). `sensitivity.ts` is P1 and may slip.

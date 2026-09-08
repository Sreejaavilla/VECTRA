/**
 * Live-operations orchestrator.
 *
 * Owns the incident-response lifecycle for the demo: a stable network running,
 * an operator-injected disruption, candidate evaluation, a recommendation, and
 * execution. It is a PRESENTATION orchestrator — every simulation number comes
 * from the frozen engine (`runSimulation` / `evaluateScenario`). The only state
 * it holds beyond React bookkeeping is the presentation phase, which is derived
 * from / advanced by real simulation events.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { resolveEventClass } from '../domain';
import {
  DEFAULT_PRIORITIES,
  evaluateScenario,
  makeColdChainScenario,
  normalizeWeights,
  runSimulation,
  type DisruptionConfig,
  type ScenarioConfig,
  type ScenarioEvaluation,
  type SimulationInputs,
  type SimulationResult,
} from './index';
import { useSimulationPlayback, type SimulationPlayback } from './useSimulationPlayback';
import { decisionWindow, type DecisionWindow } from './narrative';

export type LivePhase =
  | 'NORMAL'
  | 'INCIDENT'
  | 'ANALYZING'
  | 'DECISION_READY'
  | 'EXECUTING'
  | 'RESOLVED';

export type IncidentType =
  | 'refrigeration-failure'
  | 'route-blockage'
  | 'support-unavailable'
  | 'storage-reduction';

export const INCIDENT_LABELS: Record<IncidentType, string> = {
  'refrigeration-failure': 'Refrigeration failure',
  'route-blockage': 'Route blockage',
  'support-unavailable': 'Support vehicle unavailable',
  'storage-reduction': 'Cold storage capacity reduction',
};

export const SHIPMENT = { id: 'VX-204', doses: 2100 } as const;
const DEFAULT_MAX_TEMP_C = 14;

/** 0-100 safety slider -> objective weights that sum to 1. */
function toPriorities(safety: number): Record<string, number> {
  const s = Math.max(0, Math.min(100, safety)) / 100;
  const others = Object.keys(DEFAULT_PRIORITIES).filter((id) => id !== 'obj-safety');
  const otherTotal = others.reduce((sum, id) => sum + DEFAULT_PRIORITIES[id], 0);
  const raw: Record<string, number> = { 'obj-safety': s };
  for (const id of others) raw[id] = otherTotal === 0 ? 0 : (1 - s) * (DEFAULT_PRIORITIES[id] / otherTotal);
  return normalizeWeights(raw);
}

interface Controls {
  safetyPriority: number;
  maxTempC: number;
  supportVehicleAvailable: boolean;
  storageDoses: number;
}

function toInputs(c: Controls): SimulationInputs {
  return {
    resources: {
      'res-support-vehicle': c.supportVehicleAvailable,
      'res-cold-storage': c.storageDoses,
      'res-cold-store-b': 3000,
      'res-budget': 8,
    },
    constraints:
      c.maxTempC === DEFAULT_MAX_TEMP_C
        ? {}
        : { 'constraint-critical-temperature': c.maxTempC },
    priorities: toPriorities(c.safetyPriority),
  };
}

/** Drop overrides the scenario does not declare (a generic user scenario has
 *  no `res-cold-storage`, no `constraint-critical-temperature`, etc.). */
function sanitizeInputs(scenario: ScenarioConfig, inputs: SimulationInputs): SimulationInputs {
  const resourceIds = new Set(scenario.resources.map((r) => r.id));
  const constraintIds = new Set(scenario.constraints.map((c) => c.id));
  const objectiveIds = new Set(scenario.objectives.map((o) => o.id));
  const resources: SimulationInputs['resources'] = {};
  for (const [k, v] of Object.entries(inputs.resources)) if (resourceIds.has(k)) resources[k] = v;
  const constraints: SimulationInputs['constraints'] = {};
  for (const [k, v] of Object.entries(inputs.constraints)) if (constraintIds.has(k)) constraints[k] = v;
  // Re-map the safety slider onto whatever the scenario's "protect the product"
  // objective is called (obj-safety for pharma, obj-service for generic).
  const priorities = { ...inputs.priorities };
  if (!objectiveIds.has('obj-safety') && objectiveIds.has('obj-service')) {
    priorities['obj-service'] = priorities['obj-safety'] ?? 0;
    delete priorities['obj-safety'];
  }
  const known: Record<string, number> = {};
  for (const [k, v] of Object.entries(priorities)) if (objectiveIds.has(k)) known[k] = v;
  const total = Object.values(known).reduce((a, b) => a + b, 0);
  const normalized =
    total > 0
      ? Object.fromEntries(Object.entries(known).map(([k, v]) => [k, v / total]))
      : Object.fromEntries([...objectiveIds].map((id) => [id, 1 / objectiveIds.size]));
  return { resources, constraints, priorities: normalized };
}

const BASE_CONTROLS: Controls = {
  safetyPriority: 45,
  maxTempC: DEFAULT_MAX_TEMP_C,
  supportVehicleAvailable: true,
  storageDoses: 2400,
};

/** The stable "normal operations" baseline: no failure, shipment delivers fine. */
const BASELINE_SCENARIO = makeColdChainScenario({ refrigerationFailureAtMinutes: null });

/** The do-nothing action id for a scenario (a real no-op, else the first action). */
function baselineActionId(scenario: ScenarioConfig): string {
  return (
    scenario.actions.find((a) => a.id === 'monitor')?.id ??
    scenario.actions.find((a) => a.id === 'continue')?.id ??
    scenario.actions[0]?.id ??
    'continue'
  );
}

function baselineResultFor(scenario: ScenarioConfig): SimulationResult | null {
  const r = runSimulation(scenario, sanitizeInputs(scenario, toInputs(BASE_CONTROLS)), baselineActionId(scenario), {
    runNumber: 0,
  });
  return r.ok ? r.value.result : null;
}

/** Earliest disruptive scheduled event in a compiled user scenario. */
function firstIncident(
  scenario: ScenarioConfig,
): { type: IncidentType; atMinutes: number } | null {
  const disruptive = scenario.scheduledEvents
    .filter((e) => e.type === 'FAILURE' || e.type === 'CONSTRAINT_VIOLATED')
    .sort((a, b) => a.atMinutes - b.atMinutes)[0];
  if (!disruptive) return null;
  const type: IncidentType =
    disruptive.type === 'FAILURE' ? 'refrigeration-failure' : 'route-blockage';
  return { type, atMinutes: disruptive.atMinutes };
}

export interface LiveOperations {
  phase: LivePhase;
  playback: SimulationPlayback;
  scenario: ScenarioConfig;
  /** The trajectory currently on the map. */
  result: SimulationResult | null;
  /** The "do nothing" trajectory under the active incident (for the window + comparison). */
  doNothing: SimulationResult | null;
  evaluation: ScenarioEvaluation | null;
  incident: { type: IncidentType; atMinutes: number } | null;
  window: DecisionWindow | null;
  controls: Controls;
  /** True briefly after a priority/constraint change flipped the recommendation. */
  recommendationChanged: boolean;

  start: () => void;
  injectIncident: (type: IncidentType) => void;
  analyze: () => void;
  execute: () => void;
  reset: () => void;
  setSafetyPriority: (v: number) => void;
  setMaxTempC: (v: number) => void;
}

export interface LiveOperationsOptions {
  /** A compiled user-authored scenario. When present, live ops runs THIS
   *  scenario (incidents already scheduled) instead of the pharma default. */
  userScenario?: ScenarioConfig;
}

export function useLiveOperations(options: LiveOperationsOptions = {}): LiveOperations {
  const userScenario = options.userScenario ?? null;
  const initialScenario = userScenario ?? BASELINE_SCENARIO;

  const [controls, setControls] = useState<Controls>(BASE_CONTROLS);
  const [phase, setPhase] = useState<LivePhase>(userScenario ? 'INCIDENT' : 'NORMAL');
  const [scenario, setScenario] = useState<ScenarioConfig>(initialScenario);
  const [result, setResult] = useState<SimulationResult | null>(() =>
    baselineResultFor(initialScenario),
  );
  const [doNothing, setDoNothing] = useState<SimulationResult | null>(() =>
    userScenario ? baselineResultFor(userScenario) : null,
  );
  const [evaluation, setEvaluation] = useState<ScenarioEvaluation | null>(null);
  const [incident, setIncident] = useState<{ type: IncidentType; atMinutes: number } | null>(
    userScenario ? firstIncident(userScenario) : null,
  );
  const [startTime, setStartTime] = useState(0);
  const [autoPlay, setAutoPlay] = useState(true);
  const [recommendationChanged, setRecommendationChanged] = useState(false);
  const runNo = useRef(0);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analyzeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const playback = useSimulationPlayback(result, { startTime, autoPlay });

  const window = useMemo(
    () => (doNothing && incident ? decisionWindow(doNothing) : null),
    [doNothing, incident],
  );

  const nextRun = () => (runNo.current += 1);

  /* --- start / reset (no mount effect — the baseline is the initial state) - */

  const start = useCallback(() => {
    if (analyzeTimer.current) clearTimeout(analyzeTimer.current);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    const s = userScenario ?? BASELINE_SCENARIO;
    setControls(BASE_CONTROLS);
    setScenario(s);
    setDoNothing(userScenario ? baselineResultFor(userScenario) : null);
    setEvaluation(null);
    setIncident(userScenario ? firstIncident(userScenario) : null);
    setRecommendationChanged(false);
    setStartTime(0);
    setAutoPlay(true);
    setPhase(userScenario ? 'INCIDENT' : 'NORMAL');
    setResult(baselineResultFor(s));
  }, [userScenario]);

  const reset = useCallback(() => start(), [start]);

  /* --- inject incident --------------------------------------------------- */

  const injectIncident = useCallback(
    (type: IncidentType) => {
      // The failure fires at the calibrated minute (35) whatever the operator's
      // playback position — that is the operating point where the decision
      // landscape has genuine feasible alternatives. Playback rewinds to just
      // before it so the operator watches the consequence unfold.
      const FAILURE_AT = 35;
      const disruption: DisruptionConfig = {};
      let next = { ...controls };
      if (type === 'route-blockage') {
        disruption.routeBlockage = { routeId: 'route-hub-hospital-a', atMinutes: 48 };
      } else if (type === 'support-unavailable') {
        next = { ...controls, supportVehicleAvailable: false };
      } else if (type === 'storage-reduction') {
        next = { ...controls, storageDoses: 400 };
      }

      const s = makeColdChainScenario(disruption);
      const dn = runSimulation(s, sanitizeInputs(s, toInputs(next)), 'continue', { runNumber: nextRun() });

      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (analyzeTimer.current) clearTimeout(analyzeTimer.current);
      setControls(next);
      setScenario(s);
      setEvaluation(null);
      setIncident({ type, atMinutes: FAILURE_AT });
      setStartTime(Math.min(playback.currentTime, 25));
      setAutoPlay(true);
      setPhase('INCIDENT');
      if (dn.ok) {
        setDoNothing(dn.value.result);
        setResult(dn.value.result);
      }
      // Play a short burst so the failure visibly unfolds, then hold on the
      // decision moment — the demo never depends on the presenter's timing.
      analyzeTimer.current = setTimeout(() => playback.pause(), 3200);
    },
    [controls, playback],
  );

  /* --- analyze --------------------------------------------------------- */

  const runEvaluation = useCallback(
    (s: ScenarioConfig, c: Controls) => {
      const out = evaluateScenario(s, sanitizeInputs(s, toInputs(c)), { runNumber: nextRun() });
      return out.ok ? out.value : null;
    },
    [],
  );

  /** The decision boundary: the earliest minute any candidate acts. Candidate
   *  and do-nothing trajectories are frame-identical up to here, so the map can
   *  switch between them at this instant with zero visual discontinuity. Plain
   *  const, not a hook — a trivial min over a handful of actions. */
  const decisionBoundary = Math.min(...scenario.actions.map((a) => a.decisionTimeMinutes));

  const analyze = useCallback(() => {
    playback.pause();
    // Hold exactly on the decision boundary. The live entity does NOT move and
    // is NOT replaced with a candidate preview — candidate futures live in the
    // side panel and the counterfactual comparison, never on the live map.
    playback.seek(decisionBoundary);
    setStartTime(decisionBoundary);
    setPhase('ANALYZING');
    if (analyzeTimer.current) clearTimeout(analyzeTimer.current);
    // Presentational beat only — the evaluation itself is synchronous below.
    const ev = runEvaluation(scenario, controls);
    analyzeTimer.current = setTimeout(() => {
      setEvaluation(ev);
      setPhase('DECISION_READY');
    }, 650);
  }, [scenario, controls, playback, runEvaluation, decisionBoundary]);

  /* --- priority / constraint changes ---------------------------------- */

  const reevaluate = useCallback(
    (next: Controls) => {
      setControls(next);
      if (phase !== 'DECISION_READY' && phase !== 'EXECUTING') return;
      const prev = evaluation?.recommendation?.strategyId;
      const ev = runEvaluation(scenario, next);
      setEvaluation(ev);
      if (ev?.recommendation && prev && prev !== ev.recommendation.strategyId) {
        setRecommendationChanged(true);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setRecommendationChanged(false), 4000);
      }
      // The live map keeps showing the do-nothing baseline until Execute — a
      // priority change updates the panel, never teleports the live entity.
      if (phase === 'EXECUTING') setPhase('DECISION_READY');
    },
    [phase, scenario, evaluation, runEvaluation],
  );

  const setSafetyPriority = useCallback(
    (v: number) => reevaluate({ ...controls, safetyPriority: v }),
    [controls, reevaluate],
  );
  const setMaxTempC = useCallback(
    (v: number) => reevaluate({ ...controls, maxTempC: v }),
    [controls, reevaluate],
  );

  /* --- execute ------------------------------------------------------- */

  const execute = useCallback(() => {
    if (!evaluation?.recommendation) return;
    const rec = evaluation.results.find(
      (r) => r.strategy === evaluation.recommendation!.strategyId,
    );
    if (!rec) return;
    // Execution begins one step BEFORE the chosen response's decision fires — the
    // exact state the operator was looking at. Up to that frame the chosen
    // trajectory is identical to the baseline, so nothing jumps; from there it
    // plays the real response (dispatch -> intercept -> recovery -> delivery).
    const decisionEvt = rec.events.find((e) => resolveEventClass(e) === 'decision');
    const dt = rec.scenario.simulation.timestepMinutes;
    const boundary = Math.max(
      0,
      (decisionEvt?.timestamp ?? decisionBoundary) - dt,
    );
    setResult(rec);
    setStartTime(boundary);
    setAutoPlay(true);
    setPhase('EXECUTING');
    playback.seek(boundary);
  }, [evaluation, decisionBoundary, playback]);

  /* --- EXECUTING -> RESOLVED is derived from playback completion ------ */
  const effectivePhase: LivePhase =
    phase === 'EXECUTING' && playback.atEnd ? 'RESOLVED' : phase;

  return {
    phase: effectivePhase,
    playback,
    scenario,
    result,
    doNothing,
    evaluation,
    incident,
    window,
    controls,
    recommendationChanged,
    start,
    injectIncident,
    analyze,
    execute,
    reset,
    setSafetyPriority,
    setMaxTempC,
  };
}

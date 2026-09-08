/**
 * Demo harness — a deliberate STAND-IN for the UI/UX engineer's control panel.
 * It exists so the engine and visualization are runnable end-to-end.
 *
 * Note what it does NOT do: it never computes a metric, a feasibility verdict or
 * a score. It gathers `SimulationInputs`, calls the engine, and hands the result
 * to <SimulationViewport>. Everything else is the engine's job.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  analyzeSensitivity,
  coldChainScenario,
  DEFAULT_PRIORITIES,
  evaluateScenario,
  runSimulation,
  STRATEGY_LABELS,
  normalizeWeights,
  type ScenarioEvaluation,
  type SimulationInputs,
  type SimulationResult,
} from './simulation';
import { SimulationViewport } from './components/simulation/SimulationViewport';
import styles from './App.module.css';

const STRATEGIES = Object.keys(STRATEGY_LABELS);

/** Relative weights of the non-safety objectives, used to split the remainder. */
const OTHER_OBJECTIVES = Object.keys(DEFAULT_PRIORITIES).filter((id) => id !== 'obj-safety');

interface Controls {
  safetyPriority: number;
  budgetLakh: number;
  storageDoses: number;
  supportVehicleAvailable: boolean;
  /** Hard ceiling on cargo temperature (°C) — overrides the scenario default. */
  maxTemperatureC: number;
}

/** Scenario default for the critical-temperature constraint. */
const DEFAULT_MAX_TEMP_C = 14;

/**
 * Turn a 0-100 safety slider into objective weights that sum to 1 — the global
 * convention the engine validates against. The remainder is split across the
 * other objectives in their declared proportions.
 */
function toPriorities(safetyPriority: number): Record<string, number> {
  const safety = Math.max(0, Math.min(100, safetyPriority)) / 100;
  const otherTotal = OTHER_OBJECTIVES.reduce((sum, id) => sum + DEFAULT_PRIORITIES[id], 0);
  const raw: Record<string, number> = { 'obj-safety': safety };
  for (const id of OTHER_OBJECTIVES) {
    raw[id] = otherTotal === 0 ? 0 : (1 - safety) * (DEFAULT_PRIORITIES[id] / otherTotal);
  }
  // Normalize once more so floating-point drift never trips the engine's
  // "weights must sum to 1" validation.
  return normalizeWeights(raw);
}

function toInputs(controls: Controls): SimulationInputs {
  return {
    resources: {
      'res-budget': controls.budgetLakh,
      'res-cold-storage': controls.storageDoses,
      'res-support-vehicle': controls.supportVehicleAvailable,
    },
    constraints:
      controls.maxTemperatureC === DEFAULT_MAX_TEMP_C
        ? {}
        : { 'constraint-critical-temperature': controls.maxTemperatureC },
    priorities: toPriorities(controls.safetyPriority),
  };
}

export default function App() {
  const [controls, setControls] = useState<Controls>({
    safetyPriority: 40,
    budgetLakh: 8,
    storageDoses: 2400,
    supportVehicleAvailable: true,
    maxTemperatureC: DEFAULT_MAX_TEMP_C,
  });
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [evaluation, setEvaluation] = useState<ScenarioEvaluation | null>(null);
  const [history, setHistory] = useState<SimulationResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [runCount, setRunCount] = useState(0);

  const inputs = useMemo(() => toInputs(controls), [controls]);

  const record = useCallback((next: SimulationResult) => {
    setResult(next);
    setHistory((h) => [...h, next].slice(-6));
  }, []);

  /** Simulate one strategy. */
  const run = useCallback(
    (strategy: string) => {
      const nextCount = runCount + 1;
      setRunCount(nextCount);
      const outcome = runSimulation(coldChainScenario, inputs, strategy, {
        runNumber: nextCount,
      });
      if (!outcome.ok) {
        setError(
          `${outcome.error.message}${
            outcome.error.details?.length
              ? `\n${outcome.error.details.map((d) => `• ${d.message}`).join('\n')}`
              : ''
          }`,
        );
        return;
      }
      setError(null);
      setEvaluation(null);
      record(outcome.value.result);
    },
    [inputs, record, runCount],
  );

  /** Simulate the whole decision space and recommend. */
  const evaluateAll = useCallback(() => {
    const nextCount = runCount + 1;
    setRunCount(nextCount);
    const outcome = evaluateScenario(coldChainScenario, inputs, { runNumber: nextCount });
    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    setError(null);
    setEvaluation(outcome.value);
    const recommended = outcome.value.recommendation;
    const chosen =
      outcome.value.results.find((r) => r.strategy === recommended?.strategyId) ??
      outcome.value.results[0] ??
      null;
    if (chosen) record(chosen);
  }, [inputs, record, runCount]);

  /**
   * Sensitivity is opt-in: it costs ~29 full evaluations, an order of magnitude
   * more than the decision itself, so it never rides along with every run.
   */
  const analyzeSensitivityOfRun = useCallback(() => {
    if (!evaluation) return;
    setIsAnalyzing(true);
    // The analysis is synchronous, so React would batch this state change away
    // with the one below and never paint "Analyzing…". Yielding a frame first
    // makes the pending state real rather than decorative.
    setTimeout(() => {
      const outcome = analyzeSensitivity(coldChainScenario, evaluation.inputs);
      setIsAnalyzing(false);
      if (!outcome.ok) {
        setError(outcome.error.message);
        return;
      }
      setEvaluation((current) =>
        current ? { ...current, sensitivity: outcome.value } : current,
      );
    }, 0);
  }, [evaluation]);

  /** Switch the viewport to another already-simulated strategy. */
  const selectStrategy = useCallback(
    (strategyId: string) => {
      const existing = evaluation?.results.find((r) => r.strategy === strategyId);
      if (existing) {
        setResult(existing);
        return;
      }
      run(strategyId);
    },
    [evaluation, run],
  );

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.mark}>VECTRA</span>
          <span className={styles.sub}>CAUSALIS · Decision Simulation</span>
        </div>
        <div className={styles.controls}>
          <label className={styles.field}>
            <span className="u-label">Safety priority</span>
            <input
              type="range"
              min={0}
              max={100}
              value={controls.safetyPriority}
              onChange={(e) =>
                setControls((s) => ({ ...s, safetyPriority: Number(e.target.value) }))
              }
            />
            <span className="u-mono">{controls.safetyPriority}</span>
          </label>
          <label className={styles.field}>
            <span className="u-label">Budget ₹L</span>
            <input
              type="range"
              min={1}
              max={12}
              step={0.5}
              value={controls.budgetLakh}
              onChange={(e) => setControls((s) => ({ ...s, budgetLakh: Number(e.target.value) }))}
            />
            <span className="u-mono">{controls.budgetLakh}</span>
          </label>
          <label className={styles.field}>
            <span className="u-label">Cold storage</span>
            <input
              type="range"
              min={0}
              max={3000}
              step={100}
              value={controls.storageDoses}
              onChange={(e) => setControls((s) => ({ ...s, storageDoses: Number(e.target.value) }))}
            />
            <span className="u-mono">{controls.storageDoses}</span>
          </label>
          <label className={styles.field}>
            <span className="u-label">Max temp °C</span>
            <input
              type="range"
              min={10}
              max={15}
              step={0.5}
              value={controls.maxTemperatureC}
              onChange={(e) =>
                setControls((s) => ({ ...s, maxTemperatureC: Number(e.target.value) }))
              }
            />
            <span className="u-mono">{controls.maxTemperatureC}</span>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={controls.supportVehicleAvailable}
              onChange={(e) =>
                setControls((s) => ({ ...s, supportVehicleAvailable: e.target.checked }))
              }
            />
            <span className="u-label">Support vehicle available</span>
          </label>
        </div>
        <div className={styles.strategies}>
          <button
            type="button"
            className={`${styles.strategyBtn} ${styles.evaluateBtn}`}
            onClick={evaluateAll}
          >
            Evaluate all strategies
          </button>
          {STRATEGIES.map((s) => (
            <button
              key={s}
              type="button"
              className={`${styles.strategyBtn} ${result?.strategy === s ? styles.active : ''}`}
              onClick={() => run(s)}
            >
              {STRATEGY_LABELS[s]}
            </button>
          ))}
        </div>
      </header>

      <main className={styles.stage}>
        <SimulationViewport
          result={result}
          error={error}
          evaluation={evaluation}
          isAnalyzingSensitivity={isAnalyzing}
          onAnalyzeSensitivity={analyzeSensitivityOfRun}
          onSelectStrategy={selectStrategy}
          comparisonResults={history}
          canCompare={history.length >= 2}
          onReplay={() => {
            /* Deterministic: the viewport restarts playback of the same
               immutable result — identical events, identical numbers. */
          }}
        />
      </main>
    </div>
  );
}

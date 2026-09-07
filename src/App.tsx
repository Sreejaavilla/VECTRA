/**
 * Demo harness — a deliberate STAND-IN for the UI/UX engineer's control panel.
 * It exists so the visualization layer is runnable end-to-end. The real product
 * feeds `SimulationResult`s into <SimulationViewport> from the shared UI.
 */

import { useCallback, useState } from 'react';
import {
  coldChainScenario,
  runMockSimulation,
  STRATEGY_LABELS,
  type StrategyId,
  type WhatIfInputs,
} from './simulation';
import type { SimulationResult } from './simulation/types';
import { SimulationViewport } from './components/simulation/SimulationViewport';
import styles from './App.module.css';

const STRATEGIES = Object.keys(STRATEGY_LABELS) as StrategyId[];

export default function App() {
  const [inputs, setInputs] = useState<WhatIfInputs>({
    safetyPriority: 50,
    budgetLakh: 8,
    supportVehicleAvailable: true,
  });
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [history, setHistory] = useState<SimulationResult[]>([]);
  const [runCount, setRunCount] = useState(0);

  const run = useCallback(
    (strategy: StrategyId) => {
      const nextCount = runCount + 1;
      const r = runMockSimulation(coldChainScenario, strategy, inputs, nextCount);
      setRunCount(nextCount);
      setResult(r);
      setHistory((h) => [...h, r].slice(-6));
    },
    [inputs, runCount],
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
              value={inputs.safetyPriority}
              onChange={(e) => setInputs((s) => ({ ...s, safetyPriority: Number(e.target.value) }))}
            />
            <span className="u-mono">{inputs.safetyPriority}</span>
          </label>
          <label className={styles.field}>
            <span className="u-label">Budget ₹L</span>
            <input
              type="range"
              min={2}
              max={12}
              value={inputs.budgetLakh}
              onChange={(e) => setInputs((s) => ({ ...s, budgetLakh: Number(e.target.value) }))}
            />
            <span className="u-mono">{inputs.budgetLakh}</span>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={inputs.supportVehicleAvailable}
              onChange={(e) => setInputs((s) => ({ ...s, supportVehicleAvailable: e.target.checked }))}
            />
            <span className="u-label">Support vehicle available</span>
          </label>
        </div>
        <div className={styles.strategies}>
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

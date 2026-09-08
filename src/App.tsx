/**
 * VECTRA — two modes over one engine.
 *
 *   BUILD  — author the operational world (ScenarioGraph)
 *   LIVE   — operate it through the incident-command console
 *
 * BUILD → compile → LIVE. The compiled scenario is an immutable snapshot; the
 * engine, feasibility, scoring and recommendation are untouched.
 *
 * `?mode=classic` still serves the original scenario-first harness.
 */

import { useState } from 'react';
import { LiveConsole } from './components/live/LiveConsole';
import { BuildMode } from './components/build/BuildMode';
import {
  blankGraph,
  genericLogisticsTemplate,
  pharmaTemplate,
  type CompileResult,
  type ScenarioGraph,
} from './scenario';
import ClassicApp from './ClassicApp';
import styles from './App.module.css';

type Mode = 'launch' | 'build' | 'live';

export default function App() {
  const classic =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('mode') === 'classic';
  return classic ? <ClassicApp /> : <PlatformApp />;
}

function PlatformApp() {
  const [mode, setMode] = useState<Mode>('launch');
  const [graph, setGraph] = useState<ScenarioGraph>(() => pharmaTemplate());
  const [compiled, setCompiled] = useState<CompileResult | null>(null);

  if (mode === 'launch') {
    return (
      <div className={styles.launch}>
        <div className={styles.launchCard}>
          <span className={styles.launchMark}>VECTRA</span>
          <h1>Build an operation</h1>
          <p>
            Construct an operational network, define its resources and demand, introduce
            disruptions, then simulate the consequences and the best feasible response.
          </p>
          <div className={styles.launchButtons}>
            <button
              onClick={() => {
                setGraph(pharmaTemplate());
                setMode('build');
              }}
            >
              Pharma cold-chain template
            </button>
            <button
              onClick={() => {
                setGraph(genericLogisticsTemplate());
                setMode('build');
              }}
            >
              Logistics template
            </button>
            <button
              className={styles.launchGhost}
              onClick={() => {
                setGraph(blankGraph());
                setMode('build');
              }}
            >
              Start empty
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'build') {
    return (
      <BuildMode
        graph={graph}
        onGraphChange={setGraph}
        hasCompiled={compiled?.ok ?? false}
        onExitToLive={() => setMode('live')}
        onRun={(result) => {
          setCompiled(result);
          if (result.ok) setMode('live');
        }}
      />
    );
  }

  return (
    <LiveConsole
      key={compiled?.scenario?.id + String(compiled?.scenario?.version)}
      userScenario={compiled?.scenario}
      scenarioName={graph.name}
      onEditScenario={() => setMode('build')}
    />
  );
}

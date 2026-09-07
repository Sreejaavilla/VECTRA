import { useEffect, useState } from 'react';
import type { SimulationResult } from '../../simulation/types';
import { getStateAtTime } from '../../simulation/selectors';
import styles from './DebugOverlay.module.css';

/** Toggle with the "d" key. Development aid — not part of the polished layout. */
export function DebugOverlay({
  result,
  currentTime,
  speed,
}: {
  result: SimulationResult;
  currentTime: number;
  speed: number;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'd' && !e.metaKey && !e.ctrlKey) setOpen((v) => !v);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  if (!open) return null;

  const state = getStateAtTime(result, currentTime);

  return (
    <pre className={styles.overlay}>
      {JSON.stringify(
        {
          run: result.run.runId,
          strategy: result.strategy,
          seed: result.run.seed,
          t: Number(currentTime.toFixed(2)),
          speed,
          phase: state.narrativePhase,
          focus: state.focus,
          entities: state.entities.map((e) => ({
            id: e.id,
            route: e.routeId,
            progress: Number(e.progress.toFixed(3)),
            status: e.status,
          })),
          metrics: state.metrics,
        },
        null,
        2,
      )}
    </pre>
  );
}

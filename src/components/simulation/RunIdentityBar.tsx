import type { RunIdentity, SimulationOutcome } from '../../simulation/types';
import styles from './RunIdentityBar.module.css';

interface RunIdentityBarProps {
  run: RunIdentity;
  outcome: SimulationOutcome;
  onReplay: () => void;
  onCompare?: () => void;
  canCompare?: boolean;
}

export function RunIdentityBar({ run, outcome, onReplay, onCompare, canCompare }: RunIdentityBarProps) {
  return (
    <div className={styles.bar}>
      <span className={`${styles.runId} u-mono`}>RUN #{String(run.runNumber).padStart(3, '0')}</span>
      <span className={styles.label}>{run.label}</span>
      <span className={styles.inputs}>
        {Object.entries(run.inputs)
          .filter(([k]) => k !== 'strategy')
          .map(([k, v]) => (
            <span key={k} className={styles.chip}>
              {formatKey(k)}: <b>{String(v)}</b>
            </span>
          ))}
      </span>
      <span className={`${styles.outcome} ${styles[outcome.status]}`}>{outcome.status}</span>
      <span className={styles.actions}>
        {canCompare && onCompare && (
          <button type="button" className={styles.btn} onClick={onCompare}>
            Compare
          </button>
        )}
        <button type="button" className={styles.btn} onClick={onReplay}>
          Replay
        </button>
      </span>
    </div>
  );
}

function formatKey(k: string): string {
  return k
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .replace('Lakh', '(₹L)');
}

/**
 * Causal chain strip — turns the ordered event history into a
 * "Failure → Temp ↑ → Viability ↓ → Intervention → Recovery" narrative so the
 * viewer sees consequences, not just a current value.
 */

import type { SimulationEvent } from '../../simulation/types';
import { classifyEvent } from '../../simulation/selectors';
import styles from './CausalChain.module.css';

interface CausalChainProps {
  events: SimulationEvent[];
}

const STAGE_FOR_TYPE: Record<string, string> = {
  FAILURE: 'Refrigeration failure',
  THRESHOLD_CROSSED: 'Temperature ↑ · viability ↓',
  DECISION: 'Decision taken',
  VEHICLE_DISPATCHED: 'Support dispatched',
  REROUTE: 'Route changed',
  STORAGE_TRANSFER: 'Cold-storage transfer',
  INTERCEPTION: 'Shipment intercepted',
  RECOVERY: 'Temperature recovering',
  DELIVERY: 'Delivered',
};

export function CausalChain({ events }: CausalChainProps) {
  const stages = events
    .filter((e) => STAGE_FOR_TYPE[e.type])
    .map((e) => ({ id: e.id, label: STAGE_FOR_TYPE[e.type], cls: classifyEvent(e), severity: e.severity }));

  if (stages.length === 0) {
    return <p className={styles.empty}>System nominal — no disruptions yet.</p>;
  }

  return (
    <ol className={styles.chain}>
      {stages.map((s, i) => (
        <li
          key={s.id}
          className={`${styles.node} ${s.cls === 'decision' ? styles.decision : ''} ${
            s.severity === 'critical' ? styles.crit : ''
          }`}
        >
          <span className={styles.dot} aria-hidden />
          <span className={styles.text}>{s.label}</span>
          {i < stages.length - 1 && <span className={styles.arrow} aria-hidden>↓</span>}
        </li>
      ))}
    </ol>
  );
}

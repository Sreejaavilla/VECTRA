import type { NarrativePhase, ScenarioConfig, SimulationEvent, StepMetrics } from '../../simulation/types';
import { CausalChain } from './CausalChain';
import { ViabilityBar } from './ViabilityBar';
import styles from './LiveStatePanel.module.css';

interface LiveStatePanelProps {
  metrics: StepMetrics;
  phase: NarrativePhase;
  scenario: ScenarioConfig;
  eventsSoFar: SimulationEvent[];
}

const PHASE_COPY: Record<NarrativePhase, string> = {
  NORMAL: 'Nominal',
  FAILURE: 'Failure detected',
  DETERIORATING: 'Deteriorating',
  INTERVENTION: 'Intervention underway',
  RECOVERY: 'Recovering',
  DELIVERY: 'Delivery complete',
};

export function LiveStatePanel({ metrics, phase, scenario, eventsSoFar }: LiveStatePanelProps) {
  const tempUnit = scenario.metricUnits?.temperature ?? '';
  const tempSafe = scenario.metricThresholds.temperature?.safe;
  const tempWarn = tempSafe != null && metrics.temperature != null && metrics.temperature > tempSafe;

  return (
    <section className="panel">
      <div className="panel__head">
        <span className="u-label">Live State</span>
        <span className={`${styles.phase} ${styles[`phase_${phase}`]}`}>{PHASE_COPY[phase]}</span>
      </div>
      <div className="panel__body">
        <div className={styles.metrics}>
          <div className={styles.metric}>
            <span className="u-label">Temperature</span>
            <span className={`${styles.value} u-mono ${tempWarn ? styles.warn : ''}`}>
              {metrics.temperature != null ? `${metrics.temperature.toFixed(1)}${tempUnit}` : '—'}
            </span>
          </div>
          <div className={styles.metric}>
            <span className="u-label">Viability</span>
            <span className={`${styles.value} u-mono`}>
              {metrics.viability != null ? `${metrics.viability.toFixed(0)}%` : '—'}
            </span>
          </div>
        </div>

        <ViabilityBar value={metrics.viability ?? 0} />

        <div className={styles.chainWrap}>
          <span className="u-label">Causal chain</span>
          <CausalChain events={eventsSoFar} />
        </div>
      </div>
    </section>
  );
}

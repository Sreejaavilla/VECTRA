/**
 * Side-by-side comparison of two runs. Same NOW, different simulated future.
 * Runs the same engine against different actions — no second engine.
 */

import type { SimulationResult } from '../../simulation/types';
import { getMetricSeries } from '../../simulation/selectors';
import { MetricChart } from './MetricChart';
import { TradeoffMatrix } from './TradeoffMatrix';
import styles from './ComparisonView.module.css';

interface ComparisonViewProps {
  results: SimulationResult[];
  onClose: () => void;
}

export function ComparisonView({ results, onClose }: ComparisonViewProps) {
  const [a, b] = results;
  const scenario = a.scenario;

  return (
    <div className={styles.overlay} role="dialog" aria-label="Strategy comparison">
      <div className={styles.head}>
        <span className="u-label">Comparison — same disruption, different decision</span>
        <button type="button" className={styles.close} onClick={onClose}>
          Close
        </button>
      </div>
      <div className={styles.grid}>
        {[a, b].map((r) => (
          <div key={r.run.runId} className={styles.col}>
            <div className={styles.runHead}>
              <span className={`${styles.runId} u-mono`}>RUN #{String(r.run.runNumber).padStart(3, '0')}</span>
              <span className={styles.runLabel}>{r.run.label}</span>
              <span className={`${styles.outcome} ${styles[r.outcome.status]}`}>{r.outcome.status}</span>
            </div>
            <p className={styles.summary}>{r.outcome.summary}</p>
            <MetricChart
              label="Temperature"
              series={getMetricSeries(r, 'temperature')}
              thresholds={scenario.metricThresholds.temperature}
              unit={scenario.metricUnits?.temperature}
              currentTime={r.duration}
              duration={r.duration}
              accent="var(--temp)"
              safeIsLow
            />
            <MetricChart
              label="Viability"
              series={getMetricSeries(r, 'viability')}
              thresholds={scenario.metricThresholds.viability}
              unit="%"
              currentTime={r.duration}
              duration={r.duration}
              accent="var(--viability)"
              safeIsLow={false}
            />
            {r.decisionImpact && (
              <div className={styles.impact}>
                <span className="u-label">Before → projected</span>
                <div className={styles.impactRow}>
                  <span>Viability</span>
                  <span className="u-mono">
                    {(r.decisionImpact.before.viability ?? 0).toFixed(0)}% →{' '}
                    <b>{(r.decisionImpact.projected.viability ?? 0).toFixed(0)}%</b>
                  </span>
                </div>
                <div className={styles.impactRow}>
                  <span>Risk</span>
                  <span className="u-mono">
                    {r.decisionImpact.riskBefore} → <b>{r.decisionImpact.riskAfter}</b>
                  </span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {a.tradeoffs && (
        <div className={styles.tradeoffs}>
          <TradeoffMatrix rows={a.tradeoffs} highlight={a.outcome.strategy} />
        </div>
      )}
    </div>
  );
}

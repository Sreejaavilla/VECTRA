/**
 * "Before the decision" vs "after the intervention" — the moment that shows the
 * decision changed the simulated future, not just a number. Values tween when
 * the source result changes.
 */

import { useEffect, useRef, useState } from 'react';
import type { DecisionImpact, ScenarioConfig, StepMetrics } from '../../simulation/types';
import styles from './DecisionImpactPanel.module.css';

interface DecisionImpactPanelProps {
  impact: DecisionImpact | null;
  scenario: ScenarioConfig;
  /** 0..1 — how far the "after" column has revealed (driven by playback). */
  reveal: number;
}

interface Row {
  key: keyof StepMetrics | 'risk_label';
  label: string;
  format: (v: number) => string;
}

export function DecisionImpactPanel({ impact, scenario, reveal }: DecisionImpactPanelProps) {
  if (!impact) {
    return (
      <section className="panel">
        <div className="panel__head">
          <span className="u-label">Decision Impact</span>
        </div>
        <div className="panel__body">
          <p className={styles.empty}>Run a strategy with an intervention to compare before / after.</p>
        </div>
      </section>
    );
  }

  const tempUnit = scenario.metricUnits?.temperature ?? '';
  const rows: Row[] = [
    { key: 'temperature', label: 'Temperature', format: (v) => `${v.toFixed(1)}${tempUnit}` },
    { key: 'viability', label: 'Viability', format: (v) => `${v.toFixed(0)}%` },
    { key: 'delay', label: 'Added delay', format: (v) => `${v.toFixed(0)} min` },
  ];

  return (
    <section className="panel">
      <div className="panel__head">
        <span className="u-label">Decision Impact</span>
        <span className={styles.hint}>before vs projected</span>
      </div>
      <div className={`panel__body ${styles.body}`}>
        <div className={styles.col}>
          <span className={`u-label ${styles.colHead}`}>Before decision</span>
          {rows.map((r) => (
            <Metric key={r.key} label={r.label} value={num(impact.before, r.key)} format={r.format} />
          ))}
          <div className={styles.risk}>
            Risk <strong>{impact.riskBefore ?? '—'}</strong>
          </div>
        </div>

        <div className={styles.arrow} aria-hidden>
          →
        </div>

        <div className={`${styles.col} ${styles.after}`} style={{ opacity: 0.35 + 0.65 * reveal }}>
          <span className={`u-label ${styles.colHead}`}>After intervention</span>
          {rows.map((r) => (
            <Metric
              key={r.key}
              label={r.label}
              value={lerp(num(impact.before, r.key), num(impact.projected, r.key), reveal)}
              format={r.format}
              emphasise
            />
          ))}
          <div className={styles.risk}>
            Risk <strong>{impact.riskAfter ?? '—'}</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

function num(m: StepMetrics, key: Row['key']): number {
  if (key === 'risk_label') return 0;
  return m[key] ?? 0;
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, f));
}

function Metric({
  label,
  value,
  format,
  emphasise,
}: {
  label: string;
  value: number;
  format: (v: number) => string;
  emphasise?: boolean;
}) {
  const display = useTween(value);
  return (
    <div className={styles.metric}>
      <span className="u-label">{label}</span>
      <span className={`${styles.value} u-mono ${emphasise ? styles.valueAfter : ''}`}>{format(display)}</span>
    </div>
  );
}

/** Smoothly eases a displayed number toward its target. */
function useTween(target: number): number {
  const [value, setValue] = useState(target);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const start = value;
    const t0 = performance.now();
    const dur = 400;
    const step = (now: number) => {
      const f = Math.min(1, (now - t0) / dur);
      setValue(start + (target - start) * (1 - (1 - f) ** 3));
      if (f < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return value;
}

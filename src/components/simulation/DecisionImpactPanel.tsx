/**
 * "Before the decision" vs "after the intervention" — the moment that shows the
 * decision changed the simulated future, not just a number.
 *
 * The rows and the better/worse reading both come from `impact.changes`, which
 * the engine built from each metric's own declared direction. This component
 * decides nothing about what counts as an improvement; it only draws it.
 */

import { useEffect, useRef, useState } from 'react';
import type { DecisionImpact, MetricDelta, ScenarioConfig } from '../../simulation/types';
import styles from './DecisionImpactPanel.module.css';

interface DecisionImpactPanelProps {
  impact: DecisionImpact | null;
  scenario: ScenarioConfig;
  /** 0..1 — how far the "after" column has revealed (driven by playback). */
  reveal: number;
}

/** Risk is shown as its band label, not as a number in the delta list. */
const HIDDEN_METRICS = new Set(['risk']);

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

  const changes = impact.changes.filter((c) => !HIDDEN_METRICS.has(String(c.metric)));

  return (
    <section className="panel">
      <div className="panel__head">
        <span className="u-label">Decision Impact</span>
        <span className={styles.hint}>before vs projected</span>
      </div>
      <div className={`panel__body ${styles.body}`}>
        <div className={styles.col}>
          <span className={`u-label ${styles.colHead}`}>Before decision</span>
          {changes.map((change) => (
            <Metric
              key={String(change.metric)}
              label={change.label}
              value={change.before}
              format={(v) => formatMetric(scenario, change, v)}
            />
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
          {changes.map((change) => (
            <Metric
              key={String(change.metric)}
              label={change.label}
              value={lerp(change.before, change.after, reveal)}
              format={(v) => formatMetric(scenario, change, v)}
              // The badge describes where the projection ENDS, so it only
              // appears once the projection has started revealing. Showing
              // "worse" beside an unchanged number reads as a contradiction.
              delta={reveal > 0.05 ? change : undefined}
              emphasise
            />
          ))}
          <div className={styles.risk}>
            {/* Gated on reveal for the same reason as the delta badges: the
                projected band beside unrevealed numbers reads as a mismatch. */}
            Risk <strong>{reveal > 0.05 ? (impact.riskAfter ?? '—') : (impact.riskBefore ?? '—')}</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

function formatMetric(scenario: ScenarioConfig, change: MetricDelta, value: number): string {
  const id = String(change.metric);
  const definition = scenario.metrics.find((m) => String(m.id) === id);
  const unit = definition?.unit ?? '';
  if (id === 'cost') return `₹${(value / 100000).toFixed(1)}L`;
  if (id === 'viability') return `${value.toFixed(0)}%`;
  if (id === 'delay') return `${value.toFixed(0)} min`;
  if (id === 'exposure') return `${value.toFixed(0)} ${unit}`;
  return `${value.toFixed(1)}${unit}`;
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, f));
}

function Metric({
  label,
  value,
  format,
  delta,
  emphasise,
}: {
  label: string;
  value: number;
  format: (v: number) => string;
  delta?: MetricDelta;
  emphasise?: boolean;
}) {
  const display = useTween(value);
  return (
    <div className={styles.metric}>
      <span className="u-label">{label}</span>
      <span className={`${styles.value} u-mono ${emphasise ? styles.valueAfter : ''}`}>
        {format(display)}
        {delta && delta.direction !== 'neutral' && (
          <span className={`${styles.delta} ${styles[delta.direction]}`}>
            {delta.direction === 'better' ? '▲' : '▼'} {delta.direction}
          </span>
        )}
      </span>
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

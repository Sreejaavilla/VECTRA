/**
 * Generic SVG time-series chart. Used for temperature and viability alike —
 * it holds no domain knowledge, only `series` + `thresholds` + `currentTime`.
 */

import { useId, useMemo } from 'react';
import type { MetricThresholds } from '../../simulation/types';
import type { MetricPoint } from '../../simulation/selectors';
import { formatSimulationTime } from '../../simulation/selectors';
import styles from './MetricChart.module.css';

interface MetricChartProps {
  label: string;
  series: MetricPoint[];
  thresholds?: MetricThresholds;
  unit?: string;
  currentTime: number;
  duration: number;
  accent?: string;
  /** When true the safe band is below `safe` (temperature); else above it (viability). */
  safeIsLow?: boolean;
}

const W = 300;
const H = 120;
const PAD = { top: 10, right: 10, bottom: 18, left: 30 };

export function MetricChart({
  label,
  series,
  thresholds,
  unit,
  currentTime,
  duration,
  accent = 'var(--accent)',
  safeIsLow = true,
}: MetricChartProps) {
  const clipId = useId();

  const { min, max } = useMemo(() => {
    const values = series.map((p) => p.value);
    if (thresholds?.safe != null) values.push(thresholds.safe);
    if (thresholds?.critical != null) values.push(thresholds.critical);
    const dataLo = values.length ? Math.min(...values) : 0;
    const dataHi = values.length ? Math.max(...values) : 1;

    if (thresholds?.min != null && thresholds?.max != null) {
      // Scenario defines the meaningful range; only widen if data escapes it.
      return {
        min: Math.min(thresholds.min, dataLo),
        max: Math.max(thresholds.max, dataHi),
      };
    }
    const pad = (dataHi - dataLo) * 0.12 || 1;
    return { min: dataLo - pad, max: dataHi + pad };
  }, [series, thresholds]);

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const xFor = (t: number) => PAD.left + (duration === 0 ? 0 : (t / duration) * innerW);
  const yFor = (v: number) => PAD.top + innerH - ((v - min) / (max - min || 1)) * innerH;

  const pastSeries = series.filter((p) => p.t <= currentTime + 1e-6);
  const futureSeries = series.filter((p) => p.t >= currentTime - 1e-6);

  const line = (pts: MetricPoint[]) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(p.t).toFixed(2)} ${yFor(p.value).toFixed(2)}`).join(' ');

  const currentValue = interpAt(series, currentTime);
  const cursorX = xFor(currentTime);

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className="u-label">{label}</span>
        <span className={`${styles.value} u-mono`} style={{ color: accent }}>
          {currentValue != null ? `${currentValue.toFixed(1)}${unit ?? ''}` : '—'}
        </span>
      </div>
      <svg className={styles.svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label} over time`}>
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} />
          </clipPath>
        </defs>

        {/* Threshold bands */}
        <g clipPath={`url(#${clipId})`}>
          {thresholds?.safe != null && (
            <rect
              x={PAD.left}
              width={innerW}
              y={safeIsLow ? yFor(thresholds.safe) : PAD.top}
              height={Math.max(
                0,
                safeIsLow
                  ? PAD.top + innerH - yFor(thresholds.safe)
                  : yFor(thresholds.safe) - PAD.top,
              )}
              className={styles.bandSafe}
            />
          )}
          {thresholds?.critical != null && (
            <rect
              x={PAD.left}
              width={innerW}
              y={safeIsLow ? PAD.top : yFor(thresholds.critical)}
              height={Math.max(
                0,
                safeIsLow
                  ? yFor(thresholds.critical) - PAD.top
                  : PAD.top + innerH - yFor(thresholds.critical),
              )}
              className={styles.bandCrit}
            />
          )}
        </g>

        {/* Axes */}
        <line x1={PAD.left} y1={PAD.top + innerH} x2={PAD.left + innerW} y2={PAD.top + innerH} className={styles.axis} />
        <text x={PAD.left - 4} y={yFor(max) + 3} className={styles.tick} textAnchor="end">
          {max.toFixed(0)}
        </text>
        <text x={PAD.left - 4} y={yFor(min)} className={styles.tick} textAnchor="end">
          {min.toFixed(0)}
        </text>

        {/* Projected (after NOW) then past line on top */}
        <path d={line(futureSeries)} className={styles.lineFuture} clipPath={`url(#${clipId})`} />
        <path d={line(pastSeries)} className={styles.linePast} style={{ stroke: accent }} clipPath={`url(#${clipId})`} />

        {/* Time cursor */}
        <line x1={cursorX} y1={PAD.top} x2={cursorX} y2={PAD.top + innerH} className={styles.cursor} />
        {currentValue != null && (
          <circle cx={cursorX} cy={yFor(currentValue)} r={2.4} className={styles.cursorDot} style={{ fill: accent }} />
        )}
        <text x={cursorX} y={H - 4} className={styles.tick} textAnchor="middle">
          {formatSimulationTime(currentTime)}
        </text>
      </svg>
    </div>
  );
}

function interpAt(series: MetricPoint[], t: number): number | null {
  if (series.length === 0) return null;
  if (t <= series[0].t) return series[0].value;
  if (t >= series[series.length - 1].t) return series[series.length - 1].value;
  for (let i = 1; i < series.length; i += 1) {
    if (series[i].t >= t) {
      const a = series[i - 1];
      const b = series[i];
      const f = (t - a.t) / (b.t - a.t || 1);
      return a.value + (b.value - a.value) * f;
    }
  }
  return series[series.length - 1].value;
}

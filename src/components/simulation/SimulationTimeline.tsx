/**
 * Simulation timeline. Renders the run's events as class-typed markers
 * (● system / ◆ decision) and styles the region ahead of the playhead as the
 * simulated future.
 */

import { useCallback, useRef } from 'react';
import type { SimulationEvent } from '../../simulation/types';
import { classifyEvent, formatSimulationTime } from '../../simulation/selectors';
import styles from './SimulationTimeline.module.css';

interface SimulationTimelineProps {
  currentTime: number;
  duration: number;
  events: SimulationEvent[];
  onSeek: (time: number) => void;
  onTogglePlay: () => void;
  onStep: (dir: 1 | -1) => void;
  selectedEventId?: string | null;
}

export function SimulationTimeline({
  currentTime,
  duration,
  events,
  onSeek,
  onTogglePlay,
  onStep,
  selectedEventId,
}: SimulationTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const pct = duration === 0 ? 0 : (currentTime / duration) * 100;

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onSeek(f * duration);
    },
    [duration, onSeek],
  );

  const ticks = buildTicks(duration);

  return (
    <div className={styles.wrap}>
      <div
        ref={trackRef}
        className={styles.track}
        role="slider"
        aria-label="Simulation timeline"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={formatSimulationTime(currentTime)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') onStep(1);
          else if (e.key === 'ArrowLeft') onStep(-1);
          else if (e.key === ' ') {
            e.preventDefault();
            onTogglePlay();
          }
        }}
        onPointerDown={(e) => {
          draggingRef.current = true;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          seekFromClientX(e.clientX);
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) seekFromClientX(e.clientX);
        }}
        onPointerUp={(e) => {
          draggingRef.current = false;
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        }}
      >
        <div className={styles.rail} />
        <div className={styles.railPast} style={{ width: `${pct}%` }} />
        <div className={styles.railProjected} style={{ left: `${pct}%` }} />

        {ticks.map((t) => (
          <div key={t} className={styles.tick} style={{ left: `${(t / duration) * 100}%` }}>
            <span className={styles.tickLabel}>{formatSimulationTime(t)}</span>
          </div>
        ))}

        {events.map((event) => {
          const cls = classifyEvent(event);
          const left = `${(event.timestamp / duration) * 100}%`;
          return (
            <button
              key={event.id}
              type="button"
              className={`${styles.marker} ${cls === 'decision' ? styles.markerDecision : styles.markerSystem} ${
                event.severity === 'critical' ? styles.markerCrit : ''
              } ${selectedEventId === event.id ? styles.markerActive : ''}`}
              style={{ left }}
              title={`${formatSimulationTime(event.timestamp)} — ${event.message}`}
              onClick={(e) => {
                e.stopPropagation();
                onSeek(event.timestamp);
              }}
            >
              <span className={styles.markerGlyph} aria-hidden />
              <span className={styles.markerCallout}>{shortLabel(event)}</span>
            </button>
          );
        })}

        <div className={styles.playhead} style={{ left: `${pct}%` }}>
          <span className={styles.playheadLabel}>NOW {formatSimulationTime(currentTime)}</span>
        </div>
      </div>

      <div className={styles.legend}>
        <span className={styles.captionPast}>PAST</span>
        <span>
          <span className={`${styles.legendGlyph} ${styles.markerSystem}`} /> system event
          <span className={`${styles.legendGlyph} ${styles.markerDecision}`} /> decision
        </span>
        <span className={styles.captionProjected}>PROJECTED FUTURE</span>
      </div>
    </div>
  );
}

function buildTicks(duration: number): number[] {
  if (duration <= 0) return [];
  const step = duration <= 30 ? 5 : duration <= 180 ? 20 : 60;
  const out: number[] = [];
  for (let t = 0; t <= duration; t += step) out.push(t);
  return out;
}

function shortLabel(event: SimulationEvent): string {
  const map: Record<string, string> = {
    FAILURE: 'Failure',
    THRESHOLD_CROSSED: 'Threshold',
    DECISION: 'Decision',
    VEHICLE_DISPATCHED: 'Dispatch',
    REROUTE: 'Reroute',
    RESOURCE_ALLOCATED: 'Resources',
    INTERCEPTION: 'Interception',
    STORAGE_TRANSFER: 'Transfer',
    RECOVERY: 'Recovery',
    DELIVERY: 'Delivery',
  };
  return map[event.type] ?? event.type;
}

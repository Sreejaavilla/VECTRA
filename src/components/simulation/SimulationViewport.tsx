/**
 * Top-level simulation visualization. Owns playback, derives per-frame state
 * from the immutable result, and lays out the operational console.
 *
 * Consumes only `result` (+ status flags). The engine that produced `result`
 * is irrelevant to this component.
 */

import { useCallback, useMemo, useState } from 'react';
import type {
  ScenarioEvaluation,
  SimulationEvent,
  SimulationResult,
} from '../../simulation/types';
import { useSimulationPlayback } from '../../simulation/useSimulationPlayback';
import {
  getEventsUpTo,
  getMetricSeries,
  getStateAtTime,
} from '../../simulation/selectors';
import { OperationalMap } from './OperationalMap';
import { SimulationTimeline } from './SimulationTimeline';
import { SimulationControls } from './SimulationControls';
import { MetricChart } from './MetricChart';
import { LiveStatePanel } from './LiveStatePanel';
import { ResourcePanel } from './ResourcePanel';
import { EventFeed } from './EventFeed';
import { DecisionImpactPanel } from './DecisionImpactPanel';
import { RunIdentityBar } from './RunIdentityBar';
import { ComparisonView } from './ComparisonView';
import { RecommendationPanel } from './RecommendationPanel';
import { DebugOverlay } from './DebugOverlay';
import styles from './SimulationViewport.module.css';

interface SimulationViewportProps {
  result: SimulationResult | null;
  isSimulating?: boolean;
  error?: string | null;
  comparisonResults?: SimulationResult[];
  /** Present when the whole decision space was evaluated, not one strategy. */
  evaluation?: ScenarioEvaluation | null;
  onSelectStrategy?: (strategyId: string) => void;
  onReplay: () => void;
  onRequestCompare?: () => void;
  canCompare?: boolean;
}

export function SimulationViewport({
  result,
  isSimulating = false,
  error = null,
  comparisonResults,
  evaluation = null,
  onSelectStrategy,
  onReplay,
  onRequestCompare,
  canCompare,
}: SimulationViewportProps) {
  const playback = useSimulationPlayback(result);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [showComparison, setShowComparison] = useState(false);

  const handleReplay = useCallback(() => {
    setSelectedEntityId(null);
    setSelectedEventId(null);
    playback.restart();
    onReplay();
  }, [playback, onReplay]);

  const handleEventSelect = useCallback(
    (event: SimulationEvent) => {
      setSelectedEventId(event.id);
      if (event.entityId) setSelectedEntityId(event.entityId);
      playback.seek(event.timestamp);
    },
    [playback],
  );

  const frame = useMemo(
    () => (result ? getStateAtTime(result, playback.currentTime) : null),
    [result, playback.currentTime],
  );

  const eventsSoFar = useMemo(
    () => (result ? getEventsUpTo(result, playback.currentTime) : []),
    [result, playback.currentTime],
  );

  const { activeRouteIds, completedRouteIds } = useMemo(() => {
    if (!result || !frame) return { activeRouteIds: [], completedRouteIds: [] };
    const active = new Set<string>();
    for (const e of frame.entities) if (e.active && e.routeId) active.add(e.routeId);
    const completed = new Set<string>();
    for (const step of result.steps) {
      if (step.timestamp > playback.currentTime) break;
      for (const e of step.entities) {
        if (e.routeId && !active.has(e.routeId)) completed.add(e.routeId);
      }
    }
    return { activeRouteIds: [...active], completedRouteIds: [...completed] };
  }, [result, frame, playback.currentTime]);

  const tempSeries = useMemo(() => (result ? getMetricSeries(result, 'temperature') : []), [result]);
  const viabilitySeries = useMemo(() => (result ? getMetricSeries(result, 'viability') : []), [result]);

  const decisionReveal = useMemo(() => {
    if (!result?.decisionImpact) return 0;
    const decisionEvent = result.events.find((e) => e.id === result.decisionImpact!.decisionEventId);
    const start = decisionEvent?.timestamp ?? 0;
    const end = result.duration;
    return Math.max(0, Math.min(1, (playback.currentTime - start) / Math.max(1, end - start)));
  }, [result, playback.currentTime]);

  if (error) {
    return <Placeholder title="Simulation failed" body={error} tone="error" />;
  }
  if (isSimulating) {
    return (
      <Placeholder
        title="Simulating…"
        body={'Propagating state\nEvaluating constraints\nCalculating outcomes'}
      />
    );
  }
  if (!result || !frame) {
    return (
      <Placeholder
        title="CAUSALIS Simulation"
        body={'Configure the scenario and run a simulation\nto visualize the operational response.'}
      />
    );
  }

  return (
    <div className={styles.viewport}>
      <RunIdentityBar
        run={result.run}
        outcome={result.outcome}
        onReplay={handleReplay}
        onCompare={() => {
          if (onRequestCompare) onRequestCompare();
          if (comparisonResults && comparisonResults.length >= 2) setShowComparison(true);
        }}
        canCompare={canCompare}
      />

      <div className={styles.main}>
        <section className={`panel ${styles.mapPanel}`}>
          <div className="panel__head">
            <span className="u-label">Operational Map</span>
            <span className={styles.outcomeSummary}>{result.outcome.summary}</span>
          </div>
          <div className={styles.mapBody}>
            <OperationalMap
              scenario={result.scenario}
              entities={frame.entities}
              activeRouteIds={activeRouteIds}
              completedRouteIds={completedRouteIds}
              events={eventsSoFar}
              focus={frame.focus}
              selectedEntityId={selectedEntityId}
              onSelectEntity={setSelectedEntityId}
            />
            {showComparison && comparisonResults && comparisonResults.length >= 2 && (
              <ComparisonView results={comparisonResults.slice(-2)} onClose={() => setShowComparison(false)} />
            )}
          </div>
        </section>

        <aside className={styles.rail}>
          <LiveStatePanel
            metrics={frame.metrics}
            phase={frame.narrativePhase}
            scenario={result.scenario}
            eventsSoFar={eventsSoFar}
          />
          <ResourcePanel resources={frame.resources} />
        </aside>
      </div>

      <div className={styles.lower}>
        <section className={`panel ${styles.timelinePanel}`}>
          <SimulationControls
            isPlaying={playback.isPlaying}
            atEnd={playback.atEnd}
            currentTime={playback.currentTime}
            speed={playback.speed}
            onTogglePlay={playback.toggle}
            onRestart={handleReplay}
            onStep={(d) => (d === 1 ? playback.stepForward() : playback.stepBackward())}
            onSpeed={playback.setSpeed}
          />
          <SimulationTimeline
            currentTime={playback.currentTime}
            duration={playback.duration}
            events={result.events}
            onSeek={playback.seek}
            onTogglePlay={playback.toggle}
            onStep={(d) => (d === 1 ? playback.stepForward() : playback.stepBackward())}
            selectedEventId={selectedEventId}
          />
        </section>

        <EventFeed
          events={result.events}
          currentTime={playback.currentTime}
          selectedEventId={selectedEventId}
          onSelect={handleEventSelect}
        />
      </div>

      <div className={`${styles.decisionRow} ${evaluation ? styles.decisionRowSplit : ''}`}>
        <DecisionImpactPanel
          impact={result.decisionImpact ?? null}
          scenario={result.scenario}
          reveal={decisionReveal}
        />
        {evaluation && (
          <RecommendationPanel
            evaluation={evaluation}
            activeStrategyId={result.strategy}
            onSelectStrategy={onSelectStrategy}
          />
        )}
      </div>

      <div className={styles.charts}>
        <section className={`panel ${styles.chartPanel}`}>
          <div className="panel__body">
            <MetricChart
              label="Temperature"
              series={tempSeries}
              thresholds={result.scenario.metricThresholds.temperature}
              unit={result.scenario.metricUnits?.temperature}
              currentTime={playback.currentTime}
              duration={playback.duration}
              accent="var(--temp)"
              safeIsLow
            />
          </div>
        </section>
        <section className={`panel ${styles.chartPanel}`}>
          <div className="panel__body">
            <MetricChart
              label="Viability"
              series={viabilitySeries}
              thresholds={result.scenario.metricThresholds.viability}
              unit="%"
              currentTime={playback.currentTime}
              duration={playback.duration}
              accent="var(--viability)"
              safeIsLow={false}
            />
          </div>
        </section>
      </div>

      <DebugOverlay result={result} currentTime={playback.currentTime} speed={playback.speed} />
    </div>
  );
}

function Placeholder({
  title,
  body,
  tone,
}: {
  title: string;
  body: string;
  tone?: 'error';
}) {
  return (
    <div className={`${styles.placeholder} ${tone === 'error' ? styles.placeholderError : ''}`}>
      <h2>{title}</h2>
      {body.split('\n').map((line, i) => (
        <p key={i}>{line}</p>
      ))}
    </div>
  );
}

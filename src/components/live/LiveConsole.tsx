/**
 * VECTRA Live Operations console — the incident-command experience.
 *
 * The map is the hero. A phase-driven command drawer walks the operator through
 * NORMAL -> INCIDENT -> ANALYZING -> DECISION_READY -> EXECUTING -> RESOLVED.
 * Every number shown comes from the frozen engine via `useLiveOperations`; this
 * file only arranges and phrases it.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  getEventsUpTo,
  getStateAtTime,
} from '../../simulation/selectors';
import {
  incidentTimeline,
  translateViolation,
  type NarrativeLine,
} from '../../simulation/narrative';
import {
  INCIDENT_LABELS,
  useLiveOperations,
  type IncidentType,
} from '../../simulation/useLiveOperations';
import { useNarration } from '../../simulation/useNarration';
import {
  visibleStripMetrics,
  scenarioHasMetric,
  formatMetric,
  describeDoNothing,
} from '../../simulation/metricFormat';
import type { ScenarioConfig, SimulationResult } from '../../simulation/types';
import { OperationalMap } from '../simulation/OperationalMap';
import { DecisionImpactPanel } from '../simulation/DecisionImpactPanel';
import { MetricChart } from '../simulation/MetricChart';
import { getMetricSeries } from '../../simulation/selectors';
import styles from './LiveConsole.module.css';

const STRATEGY_BLURB: Record<string, string> = {
  continue: 'Hold the current plan',
  reroute_storage: 'Divert through a regional cold store',
  emergency_interception: 'Dispatch the support vehicle to intercept',
  hybrid: 'Split the shipment — intercept the critical doses, store the rest',
};

const PHASE_LABEL: Record<string, string> = {
  NORMAL: 'Normal',
  INCIDENT: 'Incident',
  ANALYZING: 'Analyzing',
  DECISION_READY: 'Decision required',
  EXECUTING: 'Recovering',
  RESOLVED: 'Resolved',
};

interface LiveConsoleProps {
  /** A compiled user-authored scenario. Absent = the pharma reference demo. */
  userScenario?: ScenarioConfig;
  scenarioName?: string;
  onEditScenario?: () => void;
}

export function LiveConsole({ userScenario, scenarioName, onEditScenario }: LiveConsoleProps = {}) {
  const ops = useLiveOperations({ userScenario });
  const narration = useNarration();
  const { playback, result, evaluation, phase, incident, window: decWindow } = ops;
  const now = playback.currentTime;
  const [showEvidence, setShowEvidence] = useState(false);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);

  const frame = useMemo(
    () => (result ? getStateAtTime(result, now) : null),
    [result, now],
  );
  const eventsSoFar = useMemo(
    () => (result ? getEventsUpTo(result, now) : []),
    [result, now],
  );
  const timeline = useMemo(
    () => (result ? incidentTimeline(result, now) : []),
    [result, now],
  );

  const { activeRouteIds, completedRouteIds } = useMemo(() => {
    if (!result || !frame) return { activeRouteIds: [] as string[], completedRouteIds: [] as string[] };
    const active = new Set<string>();
    for (const e of frame.entities) if (e.active && e.routeId) active.add(e.routeId);
    const completed = new Set<string>();
    for (const step of result.steps) {
      if (step.timestamp > now) break;
      for (const e of step.entities) if (e.routeId && !active.has(e.routeId)) completed.add(e.routeId);
    }
    return { activeRouteIds: [...active], completedRouteIds: [...completed] };
  }, [result, frame, now]);

  // Routes the currently-shown recommendation actually travels.
  const recommendedRouteIds = useMemo(() => {
    if (phase !== 'DECISION_READY' || !result) return [];
    const set = new Set<string>();
    for (const step of result.steps) for (const e of step.entities) if (e.routeId) set.add(e.routeId);
    return [...set];
  }, [phase, result]);

  /* --- narration ------------------------------------------------------- */
  useEffect(() => {
    for (const line of timeline) if (line.speak) narration.say(line.id, line.speak);
  }, [timeline, narration]);

  useEffect(() => {
    if (phase === 'DECISION_READY' && evaluation) {
      const n = evaluation.feasibleStrategies.length;
      narration.say('phase:decision', `VECTRA has identified ${n} feasible response ${n === 1 ? 'strategy' : 'strategies'}.`);
      if (evaluation.recommendation) {
        narration.say(
          `rec:${evaluation.recommendation.strategyId}`,
          `Recommended response: ${evaluation.recommendation.label}.`,
        );
      }
    }
    if (phase === 'RESOLVED') narration.say('phase:resolved', 'Shipment delivered successfully.');
  }, [phase, evaluation, narration]);

  const statusTone = phaseTone(phase);

  return (
    <div className={styles.console} data-phase={phase}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.mark}>VECTRA</span>
          <span className={styles.sub}>{scenarioName ?? 'Live Operations'}</span>
        </div>
        {onEditScenario && (
          <button type="button" className={styles.ghostBtn} onClick={onEditScenario}>
            ← Build
          </button>
        )}
        <div className={`${styles.statusPill} ${styles[`tone_${statusTone}`]}`}>
          <span className={styles.statusDot} />
          {PHASE_LABEL[phase]}
        </div>
        <div className={styles.headerRight}>
          <button
            type="button"
            className={`${styles.voiceBtn} ${narration.enabled ? styles.voiceOn : ''}`}
            onClick={narration.toggle}
            disabled={!narration.supported}
            title={narration.supported ? 'Toggle voice narration' : 'Speech synthesis unavailable'}
          >
            {narration.enabled ? '🔊' : '🔈'} Voice
          </button>
          <button type="button" className={styles.ghostBtn} onClick={ops.reset}>
            Reset
          </button>
        </div>
      </header>

      <div className={styles.body}>
        {/* HERO MAP */}
        <section className={styles.mapPane}>
          <div className={styles.mapChrome}>
            <span className="u-label">Operational Network</span>
            <span className={styles.clock}>
              T+{Math.round(now)} min
              <button
                type="button"
                className={styles.playBtn}
                onClick={playback.toggle}
                aria-label={playback.isPlaying ? 'Pause' : 'Play'}
              >
                {playback.isPlaying ? '❚❚' : '▶'}
              </button>
            </span>
          </div>
          <div className={styles.mapBody}>
            {frame && result ? (
              <OperationalMap
                scenario={result.scenario}
                entities={frame.entities}
                activeRouteIds={activeRouteIds}
                completedRouteIds={completedRouteIds}
                events={eventsSoFar}
                focus={frame.focus}
                selectedEntityId={selectedEntityId}
                onSelectEntity={setSelectedEntityId}
                recommendedRouteIds={recommendedRouteIds}
              />
            ) : (
              <div className={styles.mapEmpty}>Establishing network link…</div>
            )}
          </div>
          <LiveStatusStrip result={result} time={now} phase={phase} />
        </section>

        {/* COMMAND DRAWER */}
        <aside className={styles.drawer}>
          <CommandDrawer
            ops={ops}
            onExecute={ops.execute}
            onOpenEvidence={() => setShowEvidence(true)}
          />
          <IncidentTimeline lines={timeline} />
        </aside>
      </div>

      {showEvidence && result && (
        <EvidenceDrawer result={result} onClose={() => setShowEvidence(false)} />
      )}

      {decWindow && incident && phase !== 'RESOLVED' && phase !== 'NORMAL' && (
        <DecisionWindowBar
          incidentAt={incident.atMinutes}
          breachAt={decWindow.breachAtMinutes}
          now={now}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------- *
 * Command drawer — the phase-driven right rail
 * --------------------------------------------------------------------------- */

function CommandDrawer({
  ops,
  onExecute,
  onOpenEvidence,
}: {
  ops: ReturnType<typeof useLiveOperations>;
  onExecute: () => void;
  onOpenEvidence: () => void;
}) {
  const { phase, evaluation, doNothing, incident } = ops;
  const [incidentType, setIncidentType] = useState<IncidentType>('refrigeration-failure');

  if (phase === 'NORMAL') {
    return (
      <div className={styles.card}>
        <span className="u-label">Incident Control</span>
        <p className={styles.stable}>
          Network stable · {ops.scenario.initialState.entities.filter((e) => e.kind === 'shipment_vehicle').length}{' '}
          shipments in transit · {ops.scenario.facilities.filter((f) => f.kind === 'destination').length}{' '}
          destinations
        </p>
        <label className={styles.field}>
          <span className="u-label">Inject disruption</span>
          <select
            className={styles.select}
            value={incidentType}
            onChange={(e) => setIncidentType(e.target.value as IncidentType)}
          >
            {(Object.keys(INCIDENT_LABELS) as IncidentType[]).map((t) => (
              <option key={t} value={t}>
                {INCIDENT_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={() => ops.injectIncident(incidentType)}
        >
          Inject Incident
        </button>
        <PriorityDeck ops={ops} compact />
      </div>
    );
  }

  if (phase === 'INCIDENT') {
    const breach = ops.window?.breachAtMinutes ?? null;
    const remaining =
      breach != null ? Math.max(0, Math.ceil(breach - ops.playback.currentTime)) : null;
    const doNothingLast = doNothing?.steps.at(-1)?.metrics;
    const doNothingLine =
      ops.result && doNothingLast ? describeDoNothing(ops.result.scenario, doNothingLast) : null;
    const isColdChain = ops.result ? scenarioHasMetric(ops.result.scenario, 'temperature') : true;
    return (
      <div className={`${styles.card} ${styles.alertCard}`}>
        <span className={styles.critLabel}>Critical Incident</span>
        <h2 className={styles.alertHeadline}>
          {incident ? INCIDENT_LABELS[incident.type] : 'Disruption'} detected
        </h2>
        <ul className={styles.factList}>
          <li>
            <strong>{ops.evaluation?.results.length ?? ops.scenario.actions.length}</strong> response
            options — <strong>{ops.scenario.initialState.entities.filter((e) => e.kind === 'shipment_vehicle').length}</strong> shipments in transit
          </li>
          {remaining != null && (
            <li>
              Decision window <strong>{remaining} min</strong>
              {isColdChain ? ' before the cold-chain limit' : ' before service falls short'}
            </li>
          )}
          {doNothingLine && (
            <li>
              Do nothing → <strong>{doNothingLine}</strong>
            </li>
          )}
        </ul>
        <button type="button" className={styles.primaryBtn} onClick={ops.analyze}>
          Analyze Response
        </button>
      </div>
    );
  }

  if (phase === 'ANALYZING') {
    return (
      <div className={styles.card}>
        <span className="u-label">VECTRA</span>
        <p className={styles.analyzing}>
          <span className={styles.spinner} /> Simulating response options…
        </p>
        <p className={styles.analyzingSub}>
          Evaluating candidate futures against constraints and priorities.
        </p>
      </div>
    );
  }

  if ((phase === 'DECISION_READY' || phase === 'EXECUTING') && evaluation) {
    const rec = evaluation.recommendation;
    const total = evaluation.feasibleStrategies.length + evaluation.infeasibleStrategies.length;
    if (!rec) {
      return (
        <div className={`${styles.card} ${styles.alertCard}`}>
          <span className={styles.critLabel}>No feasible response</span>
          <p>Every candidate future violates a hard constraint under these inputs.</p>
          <RejectedList evaluation={evaluation} />
          <PriorityDeck ops={ops} />
        </div>
      );
    }
    return (
      <div className={styles.card}>
        <div className={`${styles.recBanner} ${ops.recommendationChanged ? styles.recFlash : ''}`}>
          <span className="u-label">VECTRA recommends</span>
          <strong className={styles.recName}>{rec.label}</strong>
          <span className={styles.recBlurb}>
            {STRATEGY_BLURB[rec.strategyId] ?? 'Best feasible response'}
          </span>
          <span className={styles.futuresLine}>
            {evaluation.feasibleStrategies.length} of {total} futures feasible
          </span>
        </div>

        {phase === 'DECISION_READY' && (
          <button type="button" className={styles.executeBtn} onClick={onExecute}>
            Execute Response
          </button>
        )}
        {phase === 'EXECUTING' && (
          <p className={styles.executingNote}>Recovery in progress…</p>
        )}

        {ops.recommendationChanged && (
          <p className={styles.updatedNote}>
            Recommendation updated — {rec.label} now scores highest under the new priorities.
          </p>
        )}

        <WhyList reasons={rec.reasons.map((r) => r.text)} />

        <FutureBars evaluation={evaluation} recommendedId={rec.strategyId} doNothing={doNothing} />

        <PriorityDeck ops={ops} />

        <button type="button" className={styles.linkBtn} onClick={onOpenEvidence}>
          View full evidence →
        </button>
      </div>
    );
  }

  if (phase === 'RESOLVED') {
    const via = ops.result?.outcome.finalMetrics.viability;
    const impact = ops.result?.decisionImpact;
    return (
      <div className={`${styles.card} ${styles.resolvedCard}`}>
        <span className={styles.okLabel}>Shipment Stabilized</span>
        <h2 className={styles.resolvedHeadline}>
          {via != null ? `${Math.round(via)}% viability preserved` : 'Delivery completed'}
        </h2>
        {impact && (
          <p className={styles.resolvedSub}>
            Before recovery the plan was projected to fail the cold-chain limit. The executed
            response completed delivery within the required window.
          </p>
        )}
        <div className={styles.resolvedActions}>
          <button type="button" className={styles.linkBtn} onClick={onOpenEvidence}>
            View evidence →
          </button>
          <button type="button" className={styles.primaryBtn} onClick={ops.reset}>
            Reset Simulation
          </button>
        </div>
      </div>
    );
  }

  return null;
}

/* --------------------------------------------------------------------------- *
 * Sub-components
 * --------------------------------------------------------------------------- */

function LiveStatusStrip({
  result,
  time,
  phase,
}: {
  result: SimulationResult | null;
  time: number;
  phase: string;
}) {
  if (!result) return <div className={styles.statusStrip} />;
  const frame = getStateAtTime(result, time);
  const m = frame.metrics;
  const isColdChain = scenarioHasMetric(result.scenario, 'temperature');
  const temp = m.temperature ?? 5;
  const via = m.viability ?? 100;
  const coverage = m.serviceCoverage ?? 0;
  const rising =
    isColdChain &&
    (result.steps.find((s) => s.timestamp > time + 5)?.metrics.temperature ?? temp) > temp + 0.05;

  // Status word is derived from whichever risk signal the scenario models.
  const atRisk = isColdChain ? via < 60 || temp > 13 : coverage < 0.5 && time > 0;
  const statusWord =
    phase === 'RESOLVED'
      ? 'DELIVERED'
      : phase === 'NORMAL'
        ? 'NORMAL'
        : atRisk
          ? 'AT RISK'
          : phase === 'EXECUTING'
            ? 'RECOVERING'
            : 'DEGRADING';

  const stripMetrics = visibleStripMetrics(result.scenario);

  return (
    <div className={styles.statusStrip}>
      <div className={styles.stat}>
        <span className="u-label">Network</span>
        <span className={styles.statVal}>{result.scenario.facilities.length} nodes</span>
      </div>
      <div className={styles.stat}>
        <span className="u-label">Status</span>
        <span className={`${styles.statVal} ${styles[`status_${statusWord.replace(' ', '')}`] ?? ''}`}>
          {statusWord}
        </span>
      </div>
      {stripMetrics.map((vm) => {
        const raw = m[vm.id as keyof typeof m];
        return (
          <div className={styles.stat} key={vm.id}>
            <span className="u-label">{vm.shortLabel}</span>
            <span className={`${styles.statVal} u-mono`}>
              {formatMetric(vm.definition, raw)}
              {vm.id === 'temperature' && rising ? ' ↑' : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DecisionWindowBar({
  incidentAt,
  breachAt,
  now,
}: {
  incidentAt: number;
  breachAt: number | null;
  now: number;
}) {
  if (breachAt == null) return null;
  const total = Math.max(1, breachAt - incidentAt);
  const remaining = Math.max(0, breachAt - now);
  const pct = Math.max(0, Math.min(1, remaining / total));
  return (
    <div className={styles.windowBar} role="status">
      <span className="u-label">Decision window</span>
      <span className={styles.windowTime}>{Math.ceil(remaining)} min remaining</span>
      <div className={styles.windowTrack}>
        <div
          className={styles.windowFill}
          style={{ width: `${pct * 100}%` }}
          data-low={pct < 0.34}
        />
      </div>
      <span className={styles.windowNote}>Cold-chain limit projected at T+{Math.round(breachAt)} min</span>
    </div>
  );
}

function WhyList({ reasons }: { reasons: string[] }) {
  return (
    <div className={styles.section}>
      <span className="u-label">Why this decision</span>
      <ul className={styles.whyList}>
        {reasons.slice(0, 4).map((r, i) => (
          <li key={i}>
            <span className={styles.check}>✓</span>
            {r}
          </li>
        ))}
      </ul>
    </div>
  );
}

const OBJ_ORDER = ['Safety', 'Cost', 'Speed'];

function FutureBars({
  evaluation,
  recommendedId,
  doNothing,
}: {
  evaluation: NonNullable<ReturnType<typeof useLiveOperations>['evaluation']>;
  recommendedId: string;
  doNothing: SimulationResult | null;
}) {
  const rows = evaluation.recommendation?.tradeoffs ?? [];
  const labelById = new Map(evaluation.results.map((r) => [r.strategyLabel, r.strategy]));
  const feasibleLabels = new Set(
    evaluation.results.filter((r) => r.feasibility?.feasible).map((r) => r.strategyLabel),
  );

  return (
    <div className={styles.section}>
      <span className="u-label">Other futures</span>
      <div className={styles.futures}>
        {rows.map((row) => {
          const id = labelById.get(row.strategy);
          const feasible = feasibleLabels.has(row.strategy);
          const isRec = id === recommendedId;
          return (
            <div
              key={row.strategy}
              className={`${styles.future} ${isRec ? styles.futureRec : ''} ${
                feasible ? '' : styles.futureInfeasible
              }`}
            >
              <div className={styles.futureHead}>
                <span className={styles.futureName}>{row.strategy}</span>
                {!feasible && <span className={styles.futureX}>✕ rejected</span>}
                {isRec && <span className={styles.futureStar}>★</span>}
              </div>
              {feasible && (
                <div className={styles.futureBars}>
                  {OBJ_ORDER.map((obj) => {
                    const raw = row.scores[obj] ?? 0; // -1..2
                    const fill = Math.max(0, Math.min(1, (raw + 1) / 3));
                    return (
                      <div key={obj} className={styles.futureBarRow}>
                        <span className={styles.futureBarLabel}>{obj}</span>
                        <span className={styles.futureBarTrack}>
                          <span className={styles.futureBarFill} style={{ width: `${fill * 100}%` }} />
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {!feasible && (
                <p className={styles.futureReason}>
                  {rejectionText(evaluation, row.strategy)}
                </p>
              )}
            </div>
          );
        })}
        {doNothing &&
          (() => {
            const line = describeDoNothing(
              evaluation.scenario,
              doNothing.steps.at(-1)?.metrics ?? {},
            );
            return line ? <p className={styles.doNothing}>Doing nothing: {line}.</p> : null;
          })()}
      </div>
    </div>
  );
}

function rejectionText(
  evaluation: NonNullable<ReturnType<typeof useLiveOperations>['evaluation']>,
  label: string,
): string {
  const rej = evaluation.recommendation?.rejectedAlternatives.find((a) => a.label === label);
  if (!rej) return 'Not feasible.';
  const report = evaluation.infeasibleStrategies.find((r) => r.strategyId === rej.strategyId);
  const hard = report?.violations.find((v) => v.severity === 'hard');
  return hard ? translateViolation(hard).detail : rej.reason;
}

function RejectedList({
  evaluation,
}: {
  evaluation: NonNullable<ReturnType<typeof useLiveOperations>['evaluation']>;
}) {
  return (
    <ul className={styles.rejectedList}>
      {evaluation.infeasibleStrategies.map((r) => {
        const hard = r.violations.find((v) => v.severity === 'hard');
        const op = hard ? translateViolation(hard) : null;
        return (
          <li key={r.strategyId}>
            <span className={styles.futureX}>✕</span>
            <strong>{op?.title ?? 'Constraint'}</strong> {op?.detail ?? 'infeasible'}
          </li>
        );
      })}
    </ul>
  );
}

function PriorityDeck({
  ops,
  compact = false,
}: {
  ops: ReturnType<typeof useLiveOperations>;
  compact?: boolean;
}) {
  const s = ops.controls.safetyPriority;
  const interpretation =
    s >= 65 ? 'Prioritising product safety' : s <= 35 ? 'Prioritising cost and speed' : 'Balancing safety, cost and speed';
  return (
    <div className={`${styles.section} ${styles.priorityDeck}`}>
      <span className="u-label">Decision priorities</span>
      <label className={styles.prioRow}>
        <span>Safety</span>
        <input
          type="range"
          min={0}
          max={100}
          value={s}
          onChange={(e) => ops.setSafetyPriority(Number(e.target.value))}
        />
        <span className={styles.prioAllocation}>Cost &amp; speed</span>
      </label>
      <p className={styles.prioInterpretation}>{interpretation}</p>
      {!compact && (
        <label className={styles.prioRow}>
          <span>Max temp</span>
          <input
            type="range"
            min={10}
            max={15}
            step={0.5}
            value={ops.controls.maxTempC}
            onChange={(e) => ops.setMaxTempC(Number(e.target.value))}
          />
          <span className={`${styles.prioAllocation} u-mono`}>{ops.controls.maxTempC}°C</span>
        </label>
      )}
    </div>
  );
}

function IncidentTimeline({ lines }: { lines: NarrativeLine[] }) {
  return (
    <div className={styles.timelineCard}>
      <span className="u-label">Incident timeline</span>
      {lines.length === 0 ? (
        <p className={styles.timelineEmpty}>All systems nominal.</p>
      ) : (
        <ol className={styles.timeline}>
          {lines.map((l) => (
            <li key={l.id} className={styles[`tl_${l.tone}`]}>
              <span className={styles.tlTime}>T+{Math.round(l.atMinutes)}</span>
              <span className={styles.tlBody}>
                <span className={styles.tlHeadline}>{l.headline}</span>
                {l.detail && <span className={styles.tlDetail}>{l.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function EvidenceDrawer({
  result,
  onClose,
}: {
  result: SimulationResult;
  onClose: () => void;
}) {
  const isColdChain = scenarioHasMetric(result.scenario, 'temperature');
  const temp = getMetricSeries(result, 'temperature');
  const via = getMetricSeries(result, 'viability');
  const coverage = getMetricSeries(result, 'serviceCoverage').map((p) => ({ t: p.t, value: p.value * 100 }));
  const delay = getMetricSeries(result, 'delay');
  return (
    <div className={styles.evidenceOverlay} role="dialog" aria-label="Decision evidence">
      <div className={styles.evidencePanel}>
        <div className={styles.evidenceHead}>
          <span className="u-label">Evidence · {result.strategyLabel}</span>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>
            Close
          </button>
        </div>
        <div className={styles.evidenceBody}>
          <DecisionImpactPanel
            impact={result.decisionImpact ?? null}
            scenario={result.scenario}
            reveal={1}
          />
          <div className={styles.evidenceCharts}>
            {isColdChain ? (
              <>
                <MetricChart
                  label="Temperature"
                  series={temp}
                  thresholds={result.scenario.metricThresholds.temperature}
                  unit="°C"
                  currentTime={result.duration}
                  duration={result.duration}
                  accent="var(--temp)"
                  safeIsLow
                />
                <MetricChart
                  label="Viability"
                  series={via}
                  thresholds={result.scenario.metricThresholds.viability}
                  unit="%"
                  currentTime={result.duration}
                  duration={result.duration}
                  accent="var(--viability)"
                  safeIsLow={false}
                />
              </>
            ) : (
              <>
                <MetricChart
                  label="Service coverage"
                  series={coverage}
                  unit="%"
                  currentTime={result.duration}
                  duration={result.duration}
                  accent="var(--viability)"
                  safeIsLow={false}
                />
                <MetricChart
                  label="Delivery delay"
                  series={delay}
                  unit="min"
                  currentTime={result.duration}
                  duration={result.duration}
                  accent="var(--temp)"
                  safeIsLow
                />
              </>
            )}
          </div>
          <ConstraintEvidence result={result} />
        </div>
      </div>
    </div>
  );
}

function ConstraintEvidence({ result }: { result: SimulationResult }) {
  const violations = result.violations ?? [];
  if (violations.length === 0) {
    return <p className={styles.noViolations}>No constraints were breached on this trajectory.</p>;
  }
  return (
    <ul className={styles.constraintList}>
      {violations.map((v, i) => {
        const op = translateViolation(v);
        return (
          <li key={i} className={v.severity === 'hard' ? styles.cHard : styles.cSoft}>
            <strong>{op.title}</strong>
            <span>{op.detail}</span>
            {v.atMinutes != null && <span className={styles.cAt}>T+{Math.round(v.atMinutes)} min</span>}
          </li>
        );
      })}
    </ul>
  );
}

/* --------------------------------------------------------------------------- */

function phaseTone(phase: string): 'ok' | 'warn' | 'crit' | 'decision' | 'neutral' {
  switch (phase) {
    case 'NORMAL':
      return 'ok';
    case 'INCIDENT':
      return 'crit';
    case 'ANALYZING':
      return 'neutral';
    case 'DECISION_READY':
      return 'decision';
    case 'EXECUTING':
      return 'warn';
    case 'RESOLVED':
      return 'ok';
    default:
      return 'neutral';
  }
}

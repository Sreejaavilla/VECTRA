/**
 * The recommendation, and — more importantly — why.
 *
 * Reasons are generated FROM the scoring arithmetic, not written alongside it.
 * Every objective reason carries the `ObjectiveContribution` it describes, so
 * "safety was the dominant driver" is always accompanied by the
 * `0.40 × 0.91 = 0.364` that makes it true. There is nothing here for a
 * sceptical reader to take on faith.
 */

import type { FeasibilityReport, ObjectiveContribution } from '../domain';
import type {
  Recommendation,
  RecommendationReason,
  RejectedAlternative,
  TradeoffRow,
} from '../simulation/types';
import { toTradeoffScores } from './scoring';

export interface ScoredCandidate {
  strategyId: string;
  label: string;
  score: number;
  penalty: number;
  contributions: ObjectiveContribution[];
  feasibility: FeasibilityReport;
}

function formatContribution(c: ObjectiveContribution): string {
  return `${c.weight.toFixed(2)} × ${c.normalizedValue.toFixed(2)} = ${c.contribution.toFixed(3)}`;
}

function objectiveReasons(
  winner: ScoredCandidate,
  runnerUp: ScoredCandidate | undefined,
): RecommendationReason[] {
  const ranked = [...winner.contributions].sort(
    (a, b) => b.contribution - a.contribution || a.objectiveId.localeCompare(b.objectiveId),
  );
  const reasons: RecommendationReason[] = [];

  ranked.slice(0, 3).forEach((contribution, index) => {
    const role = index === 0 ? 'dominant driver' : 'supporting driver';
    reasons.push({
      kind: 'objective',
      contribution,
      text: `${contribution.label}: ${formatContribution(contribution)} — ${role}`,
    });
  });

  if (runnerUp) {
    const gaps = winner.contributions
      .map((c) => {
        const other = runnerUp.contributions.find((o) => o.objectiveId === c.objectiveId);
        return { label: c.label, gap: c.contribution - (other?.contribution ?? 0) };
      })
      .sort((a, b) => b.gap - a.gap);
    const best = gaps[0];
    if (best && best.gap > 1e-6) {
      reasons.push({
        kind: 'tradeoff',
        text: `Beats ${runnerUp.label} by ${(winner.score - runnerUp.score).toFixed(3)}, mostly on ${best.label} (+${best.gap.toFixed(3)}).`,
      });
    }
  }

  if (winner.penalty > 0) {
    reasons.push({
      kind: 'constraint',
      text: `Carries a ${winner.penalty.toFixed(3)} soft-constraint penalty, and still scores highest.`,
    });
  }

  return reasons;
}

function rejectionReason(candidate: ScoredCandidate, winner: ScoredCandidate): string {
  const { feasibility } = candidate;

  if (!feasibility.staticFeasible) {
    const hard = feasibility.violations.find(
      (v) => v.severity === 'hard' && v.scope === 'static',
    );
    return hard ? hard.message : 'Not feasible from the initial state.';
  }

  if (feasibility.trajectoryFeasible === false) {
    const hard = feasibility.violations.find(
      (v) => v.severity === 'hard' && v.scope === 'trajectory',
    );
    return hard
      ? `Became infeasible in flight — ${hard.message}`
      : 'Became infeasible during the simulation.';
  }

  const gaps = winner.contributions
    .map((c) => {
      const own = candidate.contributions.find((o) => o.objectiveId === c.objectiveId);
      return { label: c.label, gap: c.contribution - (own?.contribution ?? 0) };
    })
    .sort((a, b) => b.gap - a.gap);
  const worst = gaps[0];
  const delta = (winner.score - candidate.score).toFixed(3);
  return worst && worst.gap > 1e-6
    ? `Scores ${delta} lower, mostly on ${worst.label} (−${worst.gap.toFixed(3)}).`
    : `Scores ${delta} lower overall.`;
}

/**
 * Pick the winner from the FEASIBLE candidates only. Infeasible strategies are
 * reported as rejected with the reason they are impossible — never given a poor
 * score and quietly ranked last, which would imply they were merely worse.
 */
export function recommend(candidates: readonly ScoredCandidate[]): Recommendation | null {
  const feasible = candidates.filter((c) => c.feasibility.feasible);
  if (feasible.length === 0) return null;

  const ranked = [...feasible].sort(
    (a, b) => b.score - a.score || a.strategyId.localeCompare(b.strategyId),
  );
  const winner = ranked[0];
  const runnerUp = ranked[1];

  const tradeoffs: TradeoffRow[] = [...candidates]
    .sort((a, b) => a.strategyId.localeCompare(b.strategyId))
    .map((candidate) => ({
      strategy: candidate.label,
      scores: toTradeoffScores(candidate.contributions),
    }));

  const rejectedAlternatives: RejectedAlternative[] = candidates
    .filter((candidate) => candidate.strategyId !== winner.strategyId)
    .sort((a, b) => a.strategyId.localeCompare(b.strategyId))
    .map((candidate) => ({
      strategyId: candidate.strategyId,
      label: candidate.label,
      reason: rejectionReason(candidate, winner),
      feasible: candidate.feasibility.feasible,
      score: candidate.feasibility.feasible ? candidate.score : undefined,
    }));

  return {
    strategyId: winner.strategyId,
    label: winner.label,
    score: winner.score,
    contributions: winner.contributions,
    penalty: winner.penalty,
    reasons: objectiveReasons(winner, runnerUp),
    tradeoffs,
    rejectedAlternatives,
  };
}

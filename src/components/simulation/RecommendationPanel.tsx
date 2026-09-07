/**
 * The recommendation, with the arithmetic that produced it.
 *
 * Every reason shown here carries its `ObjectiveContribution`, so the panel
 * renders `0.40 × 0.93 = 0.371` next to "Safety — dominant driver". Nothing
 * asks the reader to take the ranking on trust, and nothing here computes a
 * score: the engine did all of it.
 */

import type { Recommendation, ScenarioEvaluation } from '../../simulation/types';
import styles from './RecommendationPanel.module.css';

interface RecommendationPanelProps {
  evaluation: ScenarioEvaluation;
  /** Highlights the strategy currently loaded in the viewport. */
  activeStrategyId?: string;
  onSelectStrategy?: (strategyId: string) => void;
}

export function RecommendationPanel({
  evaluation,
  activeStrategyId,
  onSelectStrategy,
}: RecommendationPanelProps) {
  const { recommendation } = evaluation;

  if (!recommendation) {
    return (
      <section className="panel">
        <div className="panel__head">
          <span className="u-label">Recommendation</span>
        </div>
        <div className="panel__body">
          <p className={styles.empty}>
            No feasible strategy under these constraints. Every candidate either failed a
            precondition or breached a hard limit in flight.
          </p>
          <ul className={styles.rejected}>
            {evaluation.infeasibleStrategies.map((report) => (
              <li key={report.strategyId}>
                <span className={styles.rejectedName}>{report.strategyId}</span>
                <span className={styles.rejectedReason}>
                  {report.violations.find((v) => v.severity === 'hard')?.message ??
                    'Not feasible.'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <span className="u-label">Recommendation</span>
        <span className={styles.count}>
          {evaluation.feasibleStrategies.length} of{' '}
          {evaluation.feasibleStrategies.length + evaluation.infeasibleStrategies.length} feasible
        </span>
      </div>

      <div className={`panel__body ${styles.body}`}>
        <button
          type="button"
          className={`${styles.winner} ${
            activeStrategyId === recommendation.strategyId ? styles.winnerActive : ''
          }`}
          onClick={() => onSelectStrategy?.(recommendation.strategyId)}
          disabled={!onSelectStrategy}
        >
          <span className="u-label">Recommended</span>
          <strong className={styles.winnerName}>{recommendation.label}</strong>
          <span className={`${styles.winnerScore} u-mono`}>
            score {recommendation.score.toFixed(3)}
          </span>
        </button>

        <Breakdown recommendation={recommendation} />

        <div className={styles.section}>
          <span className="u-label">Why</span>
          <ul className={styles.reasons}>
            {recommendation.reasons.map((reason, index) => (
              <li key={index} className={styles[reason.kind]}>
                {reason.text}
              </li>
            ))}
          </ul>
        </div>

        <div className={styles.section}>
          <span className="u-label">Rejected</span>
          <ul className={styles.rejected}>
            {recommendation.rejectedAlternatives.map((alternative) => (
              <li key={alternative.strategyId}>
                <button
                  type="button"
                  className={styles.rejectedName}
                  onClick={() => onSelectStrategy?.(alternative.strategyId)}
                  disabled={!onSelectStrategy}
                >
                  {alternative.label}
                </button>
                <span
                  className={`${styles.tag} ${
                    alternative.feasible ? styles.tagFeasible : styles.tagInfeasible
                  }`}
                >
                  {alternative.feasible ? 'feasible' : 'infeasible'}
                </span>
                <span className={styles.rejectedReason}>{alternative.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Breakdown({ recommendation }: { recommendation: Recommendation }) {
  const max = Math.max(...recommendation.contributions.map((c) => c.contribution), 0.001);
  return (
    <div className={styles.section}>
      <span className="u-label">Score breakdown</span>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Objective</th>
            <th scope="col">Weight</th>
            <th scope="col">Normalized</th>
            <th scope="col">Contribution</th>
          </tr>
        </thead>
        <tbody>
          {recommendation.contributions.map((contribution) => (
            <tr key={contribution.objectiveId}>
              <th scope="row" className={styles.objective}>
                {contribution.label}
                <span
                  className={styles.bar}
                  style={{ width: `${(contribution.contribution / max) * 100}%` }}
                  aria-hidden
                />
              </th>
              <td className="u-mono">{contribution.weight.toFixed(2)}</td>
              <td className="u-mono">{contribution.normalizedValue.toFixed(3)}</td>
              <td className={`u-mono ${styles.contribution}`}>
                {contribution.contribution.toFixed(3)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">
              {recommendation.penalty > 0 ? 'Total − penalty' : 'Total'}
            </th>
            <td />
            <td className="u-mono">
              {recommendation.penalty > 0 ? `−${recommendation.penalty.toFixed(3)}` : ''}
            </td>
            <td className={`u-mono ${styles.contribution}`}>
              {recommendation.score.toFixed(3)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

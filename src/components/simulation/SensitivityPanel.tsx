/**
 * What the decision is sensitive to, and what would change it.
 *
 * The bars rank local influence around the current operating point. The list
 * below them is the more actionable half: the nearest value of each input at
 * which the recommendation becomes a different strategy. An input can sit at
 * 0% influence and still carry a flip point — that means it is not binding
 * *here*, and the panel says exactly where it starts to bind.
 */

import type { ScenarioConfig, SensitivityReport } from '../../simulation/types';
import { SensitivityBars } from './SensitivityBars';
import styles from './SensitivityPanel.module.css';

interface SensitivityPanelProps {
  report: SensitivityReport | null;
  scenario: ScenarioConfig;
  isAnalyzing?: boolean;
  onAnalyze?: () => void;
}

export function SensitivityPanel({
  report,
  scenario,
  isAnalyzing = false,
  onAnalyze,
}: SensitivityPanelProps) {
  return (
    <section className="panel">
      <div className="panel__head">
        <span className="u-label">Decision Sensitivity</span>
        {report ? (
          <span className={styles.cost}>{report.evaluations} evaluations</span>
        ) : (
          onAnalyze && (
            <button
              type="button"
              className={styles.runBtn}
              onClick={onAnalyze}
              disabled={isAnalyzing}
            >
              {isAnalyzing ? 'Analyzing…' : 'Analyze'}
            </button>
          )
        )}
      </div>

      <div className={`panel__body ${styles.body}`}>
        {!report ? (
          <p className={styles.empty}>
            {isAnalyzing
              ? 'Perturbing each input and re-running the full decision…'
              : 'Run the analysis to see which inputs this recommendation depends on, and what would change it.'}
          </p>
        ) : (
          <>
            <div className={styles.section}>
              <span className="u-label">Influence on the outcome</span>
              <SensitivityBars drivers={report.drivers} />
              <p className={styles.note}>
                Local influence around the current settings. 0% means that input is
                not binding here — see below for where it starts to bind.
              </p>
            </div>

            <div className={styles.section}>
              <span className="u-label">What would change the decision</span>
              {report.flips.length === 0 ? (
                <p className={styles.note}>
                  Nothing tested changes the recommendation. {report.baselineLabel} holds
                  across every perturbation.
                </p>
              ) : (
                <ul className={styles.flips}>
                  {report.flips.map((flip, index) => {
                    const probe = report.probes.find((p) => p.flip === flip);
                    return (
                      <li key={index}>
                        <span className={styles.flipInput}>
                          {probe?.label ?? 'Input'}
                          <strong className="u-mono">
                            {' '}
                            {formatValue(flip.value, probe?.inputId, scenario)}
                          </strong>
                        </span>
                        <span className={styles.flipArrow} aria-hidden>
                          →
                        </span>
                        <span className={styles.flipTo}>{flip.toLabel}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function formatValue(
  value: number | boolean,
  inputId: string | undefined,
  scenario: ScenarioConfig,
): string {
  if (typeof value === 'boolean') return value ? 'available' : 'unavailable';
  const resource = scenario.resources.find((r) => r.id === inputId);
  if (resource?.detailFormat === 'currency-lakh') return `₹${value}L`;
  if (resource) return `${value.toLocaleString()}${resource.unit ? ` ${resource.unit}` : ''}`;
  // Objective weights read better as percentages.
  return `${Math.round(value * 100)}%`;
}

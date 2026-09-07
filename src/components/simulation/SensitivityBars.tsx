import type { SensitivityDriver } from '../../simulation/types';
import styles from './SensitivityBars.module.css';

export function SensitivityBars({ drivers }: { drivers: SensitivityDriver[] }) {
  if (drivers.length === 0) return null;
  const max = Math.max(...drivers.map((d) => d.weight));

  return (
    <ul className={styles.list}>
      {drivers.map((d) => (
        <li key={d.label} className={styles.row}>
          <span className={styles.label}>{d.label}</span>
          <span className={styles.barWrap}>
            <span className={styles.bar} style={{ width: `${(d.weight / max) * 100}%` }} />
          </span>
          <span className={`${styles.pct} u-mono`}>{Math.round(d.weight * 100)}%</span>
        </li>
      ))}
    </ul>
  );
}

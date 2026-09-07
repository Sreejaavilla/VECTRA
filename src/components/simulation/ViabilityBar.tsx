import styles from './ViabilityBar.module.css';

export function ViabilityBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const tone = pct >= 85 ? 'ok' : pct >= 70 ? 'warn' : 'crit';
  return (
    <div className={styles.wrap} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <div className={`${styles.fill} ${styles[tone]}`} style={{ width: `${pct}%` }} />
      <span className={styles.label}>{pct.toFixed(0)}% viability</span>
    </div>
  );
}

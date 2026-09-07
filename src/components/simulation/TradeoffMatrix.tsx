import type { TradeoffRow } from '../../simulation/types';
import styles from './TradeoffMatrix.module.css';

function symbol(score: number): { glyph: string; tone: string } {
  if (score >= 2) return { glyph: '✓✓', tone: 'good' };
  if (score >= 1) return { glyph: '✓', tone: 'ok' };
  if (score >= 0) return { glyph: '~', tone: 'mid' };
  return { glyph: '⚠', tone: 'bad' };
}

export function TradeoffMatrix({ rows, highlight }: { rows: TradeoffRow[]; highlight?: string }) {
  if (rows.length === 0) return null;
  const columns = Object.keys(rows[0].scores);

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th className={styles.rowHead}>Strategy</th>
          {columns.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.strategy} className={row.strategy === highlight ? styles.active : ''}>
            <td className={styles.rowHead}>{row.strategy}</td>
            {columns.map((c) => {
              const s = symbol(row.scores[c] ?? 0);
              return (
                <td key={c} className={styles[s.tone]}>
                  {s.glyph}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

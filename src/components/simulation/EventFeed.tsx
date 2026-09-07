import type { SimulationEvent } from '../../simulation/types';
import { classifyEvent, formatSimulationTime } from '../../simulation/selectors';
import styles from './EventFeed.module.css';

interface EventFeedProps {
  events: SimulationEvent[];
  currentTime: number;
  selectedEventId: string | null;
  onSelect: (event: SimulationEvent) => void;
}

export function EventFeed({ events, currentTime, selectedEventId, onSelect }: EventFeedProps) {
  const visible = [...events].filter((e) => e.timestamp <= currentTime + 1e-6).reverse();

  return (
    <section className="panel">
      <div className="panel__head">
        <span className="u-label">Events</span>
        <span className={styles.count}>{visible.length}</span>
      </div>
      <div className="panel__body">
        {visible.length === 0 ? (
          <p className={styles.empty}>No events yet. Press play.</p>
        ) : (
          <ul className={styles.list}>
            {visible.map((event) => {
              const cls = classifyEvent(event);
              return (
                <li key={event.id}>
                  <button
                    type="button"
                    className={`${styles.row} ${selectedEventId === event.id ? styles.active : ''}`}
                    onClick={() => onSelect(event)}
                  >
                    <span className={`${styles.tag} ${cls === 'decision' ? styles.decision : styles.system} ${
                      event.severity === 'critical' ? styles.crit : ''
                    }`}>
                      {cls === 'decision' ? '◆' : '●'}
                    </span>
                    <span className={`${styles.time} u-mono`}>{formatSimulationTime(event.timestamp)}</span>
                    <span className={styles.msg}>{event.message}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

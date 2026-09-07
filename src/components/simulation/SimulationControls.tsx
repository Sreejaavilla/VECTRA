import { PLAYBACK_SPEEDS, type PlaybackSpeed } from '../../simulation/useSimulationPlayback';
import { formatSimulationTime } from '../../simulation/selectors';
import styles from './SimulationControls.module.css';

interface SimulationControlsProps {
  isPlaying: boolean;
  atEnd: boolean;
  currentTime: number;
  speed: PlaybackSpeed;
  onTogglePlay: () => void;
  onRestart: () => void;
  onStep: (dir: 1 | -1) => void;
  onSpeed: (s: PlaybackSpeed) => void;
}

export function SimulationControls({
  isPlaying,
  atEnd,
  currentTime,
  speed,
  onTogglePlay,
  onRestart,
  onStep,
  onSpeed,
}: SimulationControlsProps) {
  return (
    <div className={styles.bar}>
      <div className={styles.group}>
        <button type="button" className={styles.btn} onClick={() => onStep(-1)} aria-label="Step backward">
          ⏮
        </button>
        <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onTogglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? '❚❚' : atEnd ? '↻' : '▶'}
        </button>
        <button type="button" className={styles.btn} onClick={() => onStep(1)} aria-label="Step forward">
          ⏭
        </button>
        <button type="button" className={styles.btn} onClick={onRestart} aria-label="Restart / replay">
          Replay
        </button>
      </div>

      <div className={styles.readout}>
        <span className="u-label">Sim</span>
        <span className={`${styles.clock} u-mono`}>{formatSimulationTime(currentTime)}</span>
      </div>

      <div className={styles.group} role="group" aria-label="Playback speed">
        {PLAYBACK_SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className={`${styles.speed} ${s === speed ? styles.speedActive : ''}`}
            onClick={() => onSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}

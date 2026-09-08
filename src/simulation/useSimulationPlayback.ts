/**
 * Playback controller for a `SimulationResult`. Pure view-layer concern — it
 * never mutates the result. Maps wall-clock time to simulation time so a
 * ~120-minute run plays in ~30s at 1x.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SimulationResult } from './types';

export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/** Simulation minutes advanced per real second at 1x. 120 min / 30 s = 4. */
const TIME_SCALE = 4;

export interface SimulationPlayback {
  currentTime: number;
  isPlaying: boolean;
  speed: PlaybackSpeed;
  duration: number;
  atEnd: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  restart: () => void;
  seek: (time: number) => void;
  setSpeed: (speed: PlaybackSpeed) => void;
  stepForward: () => void;
  stepBackward: () => void;
}

export interface PlaybackOptions {
  /**
   * Time to seek to when `result` changes, instead of snapping to 0. Live
   * operations swaps the displayed trajectory mid-run (inject / execute) and
   * needs playback to continue from where the operator was.
   */
  startTime?: number;
  /** Keep playing after a result swap. */
  autoPlay?: boolean;
}

export function useSimulationPlayback(
  result: SimulationResult | null,
  options: PlaybackOptions = {},
): SimulationPlayback {
  const { startTime = 0, autoPlay = false } = options;
  const duration = result?.duration ?? 0;
  const [currentTime, setCurrentTime] = useState(startTime);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeedState] = useState<PlaybackSpeed>(1);

  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  const stepTimes = useMemo(() => result?.steps.map((s) => s.timestamp) ?? [], [result]);

  // Reset whenever the underlying result identity changes. `startTime` lets a
  // caller preserve continuity across a trajectory swap.
  useEffect(() => {
    const clamped = Math.max(0, Math.min(startTime, result?.duration ?? 0));
    setCurrentTime(clamped);
    setIsPlaying(Boolean(autoPlay && result));
    lastTsRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // rAF advance loop.
  useEffect(() => {
    if (!isPlaying || !result) return;

    const tick = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const deltaSec = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;

      setCurrentTime((prev) => {
        const nextTime = prev + deltaSec * speed * TIME_SCALE;
        if (nextTime >= duration) {
          setIsPlaying(false);
          return duration;
        }
        return nextTime;
      });

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
    };
  }, [isPlaying, result, speed, duration]);

  const play = useCallback(() => {
    if (!result) return;
    setCurrentTime((prev) => (prev >= duration ? 0 : prev));
    lastTsRef.current = null;
    setIsPlaying(true);
  }, [result, duration]);

  const pause = useCallback(() => setIsPlaying(false), []);

  const toggle = useCallback(() => {
    setIsPlaying((p) => {
      if (!result) return false;
      if (!p) {
        setCurrentTime((prev) => (prev >= duration ? 0 : prev));
        lastTsRef.current = null;
      }
      return !p;
    });
  }, [result, duration]);

  const restart = useCallback(() => {
    setCurrentTime(0);
    lastTsRef.current = null;
    setIsPlaying(Boolean(result));
  }, [result]);

  const seek = useCallback(
    (time: number) => {
      setCurrentTime(Math.max(0, Math.min(duration, time)));
    },
    [duration],
  );

  const setSpeed = useCallback((next: PlaybackSpeed) => setSpeedState(next), []);

  const stepForward = useCallback(() => {
    setIsPlaying(false);
    setCurrentTime((prev) => {
      const next = stepTimes.find((t) => t > prev + 1e-6);
      return next ?? duration;
    });
  }, [stepTimes, duration]);

  const stepBackward = useCallback(() => {
    setIsPlaying(false);
    setCurrentTime((prev) => {
      const earlier = [...stepTimes].reverse().find((t) => t < prev - 1e-6);
      return earlier ?? 0;
    });
  }, [stepTimes]);

  return {
    currentTime,
    isPlaying,
    speed,
    duration,
    atEnd: duration > 0 && currentTime >= duration,
    play,
    pause,
    toggle,
    restart,
    seek,
    setSpeed,
    stepForward,
    stepBackward,
  };
}

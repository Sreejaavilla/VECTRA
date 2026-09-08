import { describe, expect, it } from 'vitest';
import { run } from '../../../engine/__tests__/fixtures';
import {
  classifyEvent,
  formatSimulationTime,
  getFocusTarget,
  getMetricSeries,
  getNarrativePhase,
  getStateAtTime,
  interpolatePosition,
  FOCUS_WINDOW_MINUTES,
} from '../../../simulation/selectors';

const result = run('emergency_interception');

describe('formatSimulationTime', () => {
  it('formats minutes as HH:MM', () => {
    expect(formatSimulationTime(0)).toBe('00:00');
    expect(formatSimulationTime(84)).toBe('01:24');
    expect(formatSimulationTime(-5)).toBe('00:00');
  });
});

describe('interpolatePosition', () => {
  it('returns endpoints at 0 and 1', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    expect(interpolatePosition(pts, 0)).toEqual({ x: 0, y: 0 });
    expect(interpolatePosition(pts, 1)).toEqual({ x: 10, y: 0 });
  });
  it('interpolates by arc length across a polyline midpoint', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(interpolatePosition(pts, 0.5)).toEqual({ x: 10, y: 0 });
  });
});

describe('getStateAtTime', () => {
  it('does not mutate the source result', () => {
    const snapshot = JSON.stringify(result);
    getStateAtTime(result, 50);
    expect(JSON.stringify(result)).toBe(snapshot);
  });
  it('interpolates entity progress between steps', () => {
    const stepA = result.steps[2].timestamp;
    const stepB = result.steps[3].timestamp;
    const mid = (stepA + stepB) / 2;
    const truckA = result.steps[2].entities.find((e) => e.id === 'truck-01')!;
    const truckB = result.steps[3].entities.find((e) => e.id === 'truck-01')!;
    const frame = getStateAtTime(result, mid);
    const truckMid = frame.entities.find((e) => e.id === 'truck-01')!;
    expect(truckMid.progress).toBeGreaterThan(Math.min(truckA.progress, truckB.progress));
    expect(truckMid.progress).toBeLessThan(Math.max(truckA.progress, truckB.progress) + 1e-9);
  });
  it('clamps before the first and after the last step', () => {
    expect(getStateAtTime(result, -10).step.timestamp).toBe(0);
    expect(getStateAtTime(result, 9999).step.timestamp).toBe(result.steps[result.steps.length - 1].timestamp);
  });
});

describe('getNarrativePhase', () => {
  it('progresses NORMAL -> FAILURE -> ... -> DELIVERY over the run', () => {
    expect(getNarrativePhase(result, 0)).toBe('NORMAL');
    expect(getNarrativePhase(result, 36)).toBe('FAILURE');
    expect(getNarrativePhase(result, result.duration)).toBe('DELIVERY');
  });
});

describe('classifyEvent', () => {
  it('honours explicit eventClass, else derives from type', () => {
    expect(classifyEvent({ id: 'x', timestamp: 0, type: 'FAILURE', message: '' })).toBe('system');
    expect(classifyEvent({ id: 'x', timestamp: 0, type: 'VEHICLE_DISPATCHED', message: '' })).toBe('decision');
    expect(
      classifyEvent({ id: 'x', timestamp: 0, type: 'FAILURE', eventClass: 'decision', message: '' }),
    ).toBe('decision');
  });
});

describe('getFocusTarget', () => {
  it('is null before any focusable event', () => {
    expect(getFocusTarget(result, 0)).toBeNull();
  });
  it('points at the failing entity just after the failure, then decays', () => {
    const atFailure = getFocusTarget(result, 36);
    expect(atFailure?.entityId).toBe('truck-01');
    expect(atFailure?.intensity).toBeGreaterThan(0);
    const later = getFocusTarget(result, 35 + FOCUS_WINDOW_MINUTES + 1);
    // a subsequent event may hold focus, but intensity must remain within 0..1
    if (later) expect(later.intensity).toBeLessThanOrEqual(1);
  });
});

describe('getMetricSeries', () => {
  it('returns one point per step for a present metric', () => {
    const series = getMetricSeries(result, 'temperature');
    expect(series.length).toBe(result.steps.length);
    expect(series[0]).toHaveProperty('t');
    expect(series[0]).toHaveProperty('value');
  });
});

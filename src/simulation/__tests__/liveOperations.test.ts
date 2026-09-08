/**
 * The live-operations orchestrator. It holds presentation state only — every
 * assertion here is really checking that it drives the frozen engine correctly
 * and never fabricates an outcome.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLiveOperations } from '../useLiveOperations';
import { useNarration } from '../useNarration';
import { canonicalSerialize } from '../../engine';

describe('useLiveOperations — start / reset', () => {
  it('starts in NORMAL with a stable baseline trajectory and no incident', () => {
    const { result } = renderHook(() => useLiveOperations());
    expect(result.current.phase).toBe('NORMAL');
    expect(result.current.result).not.toBeNull();
    expect(result.current.incident).toBeNull();
    // The baseline delivers everything and never fails.
    const last = result.current.result!.steps.at(-1)!;
    expect(last.metrics.serviceCoverage).toBeCloseTo(1, 5);
    expect(last.metrics.temperature).toBeLessThan(8);
  });

  it('reset returns to a deterministic initial state', () => {
    const { result } = renderHook(() => useLiveOperations());
    const before = canonicalSerialize(result.current.result);
    act(() => result.current.injectIncident('refrigeration-failure'));
    act(() => result.current.reset());
    expect(result.current.phase).toBe('NORMAL');
    expect(result.current.incident).toBeNull();
    expect(canonicalSerialize(result.current.result)).toBe(before);
  });
});

describe('useLiveOperations — incident injection', () => {
  it('refrigeration failure changes real state and schedules the failure event', () => {
    const { result } = renderHook(() => useLiveOperations());
    act(() => result.current.injectIncident('refrigeration-failure'));
    expect(result.current.phase).toBe('INCIDENT');
    expect(result.current.incident?.type).toBe('refrigeration-failure');
    // The do-nothing trajectory now contains a real FAILURE event and degrades.
    const dn = result.current.doNothing!;
    expect(dn.events.some((e) => e.type === 'FAILURE')).toBe(true);
    expect(dn.steps.at(-1)!.metrics.viability!).toBeLessThan(60);
    // A decision window is projected from that trajectory.
    expect(result.current.window?.breachAtMinutes).not.toBeNull();
  });

  it('route blockage makes the primary corridor impassable in the trajectory', () => {
    const { result } = renderHook(() => useLiveOperations());
    act(() => result.current.injectIncident('route-blockage'));
    const dn = result.current.doNothing!;
    expect(dn.events.some((e) => e.type === 'CONSTRAINT_VIOLATED')).toBe(true);
  });

  it('support-unavailable changes candidate feasibility, not just a label', async () => {
    const { result } = renderHook(() => useLiveOperations());
    act(() => result.current.injectIncident('support-unavailable'));
    act(() => result.current.analyze());
    await waitFor(() => expect(result.current.phase).toBe('DECISION_READY'));
    const ev = result.current.evaluation!;
    expect(ev.infeasibleStrategies.map((s) => s.strategyId)).toEqual(
      expect.arrayContaining(['emergency_interception', 'hybrid']),
    );
    expect(ev.recommendation?.strategyId).toBe('reroute_storage');
  });
});

describe('useLiveOperations — decision flow', () => {
  it('analyze runs the real engine and lands on a deterministic recommendation', async () => {
    const a = renderHook(() => useLiveOperations());
    act(() => a.result.current.injectIncident('refrigeration-failure'));
    act(() => a.result.current.analyze());
    await waitFor(() => expect(a.result.current.phase).toBe('DECISION_READY'));

    const b = renderHook(() => useLiveOperations());
    act(() => b.result.current.injectIncident('refrigeration-failure'));
    act(() => b.result.current.analyze());
    await waitFor(() => expect(b.result.current.phase).toBe('DECISION_READY'));

    expect(a.result.current.evaluation!.recommendation!.strategyId).toBe(
      b.result.current.evaluation!.recommendation!.strategyId,
    );
    expect(a.result.current.evaluation!.feasibleStrategies.length).toBeGreaterThanOrEqual(3);
  });

  it('changing safety priority re-evaluates and can flip the recommendation', async () => {
    const { result } = renderHook(() => useLiveOperations());
    act(() => result.current.injectIncident('refrigeration-failure'));
    act(() => result.current.analyze());
    await waitFor(() => expect(result.current.phase).toBe('DECISION_READY'));

    act(() => result.current.setSafetyPriority(5));
    const cheap = result.current.evaluation!.recommendation!.strategyId;
    act(() => result.current.setSafetyPriority(95));
    const safe = result.current.evaluation!.recommendation!.strategyId;
    expect(cheap).not.toBe(safe);
  });

  it('tightening the temperature ceiling shrinks the feasible set', async () => {
    const { result } = renderHook(() => useLiveOperations());
    act(() => result.current.injectIncident('refrigeration-failure'));
    act(() => result.current.analyze());
    await waitFor(() => expect(result.current.phase).toBe('DECISION_READY'));
    const before = result.current.evaluation!.feasibleStrategies.length;
    act(() => result.current.setMaxTempC(12));
    const after = result.current.evaluation!.feasibleStrategies.length;
    expect(after).toBeLessThan(before);
  });
});

describe('useLiveOperations — execution', () => {
  it('execute loads the recommended trajectory and preserves shipment conservation', async () => {
    const { result } = renderHook(() => useLiveOperations());
    act(() => result.current.injectIncident('refrigeration-failure'));
    act(() => result.current.analyze());
    await waitFor(() => expect(result.current.phase).toBe('DECISION_READY'));
    const recId = result.current.evaluation!.recommendation!.strategyId;

    act(() => result.current.execute());
    expect(result.current.phase).toBe('EXECUTING');
    expect(result.current.result!.strategy).toBe(recId);
    // The executed trajectory is a real engine result: delivers everything.
    expect(result.current.result!.steps.at(-1)!.metrics.serviceCoverage).toBeCloseTo(1, 5);
  });
});

describe('useNarration', () => {
  it('reports unsupported without throwing when SpeechSynthesis is absent', () => {
    const { result } = renderHook(() => useNarration());
    // jsdom has no speechSynthesis.
    expect(result.current.supported).toBe(false);
    expect(result.current.enabled).toBe(false);
    // These must be no-ops, not crashes.
    expect(() => result.current.say('k', 'hello')).not.toThrow();
    expect(() => result.current.reset()).not.toThrow();
  });

  it('does not speak while disabled', () => {
    const spoken: string[] = [];
    // @ts-expect-error - install a spy speechSynthesis for this test
    globalThis.speechSynthesis = { speak: (u: { text: string }) => spoken.push(u.text), cancel: () => {} };
    // @ts-expect-error - minimal utterance shim
    globalThis.SpeechSynthesisUtterance = class { text: string; constructor(t: string) { this.text = t; } };
    try {
      const { result } = renderHook(() => useNarration());
      act(() => result.current.say('k1', 'should not speak'));
      expect(spoken).toHaveLength(0);
      act(() => result.current.setEnabled(true));
      act(() => result.current.say('k2', 'now speaks'));
      act(() => result.current.say('k2', 'deduped — same key'));
      expect(spoken).toEqual(['now speaks']);
    } finally {
      // @ts-expect-error - cleanup
      delete globalThis.speechSynthesis;
      // @ts-expect-error - cleanup
      delete globalThis.SpeechSynthesisUtterance;
    }
  });
});

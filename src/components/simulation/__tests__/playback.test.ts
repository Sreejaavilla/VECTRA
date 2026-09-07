import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { coldChainScenario, runMockSimulation } from '../../../simulation/mockEngine';
import { useSimulationPlayback } from '../../../simulation/useSimulationPlayback';

const result = runMockSimulation(coldChainScenario, 'continue');

describe('useSimulationPlayback', () => {
  it('starts paused at zero', () => {
    const { result: hook } = renderHook(() => useSimulationPlayback(result));
    expect(hook.current.currentTime).toBe(0);
    expect(hook.current.isPlaying).toBe(false);
    expect(hook.current.duration).toBe(result.duration);
  });

  it('advances time while playing and can be paused', async () => {
    const { result: hook } = renderHook(() => useSimulationPlayback(result));
    act(() => hook.current.play());
    await waitFor(() => expect(hook.current.currentTime).toBeGreaterThan(0));
    act(() => hook.current.pause());
    const t = hook.current.currentTime;
    await new Promise((r) => setTimeout(r, 50));
    expect(hook.current.currentTime).toBe(t);
  });

  it('seek clamps to [0, duration]', () => {
    const { result: hook } = renderHook(() => useSimulationPlayback(result));
    act(() => hook.current.seek(99999));
    expect(hook.current.currentTime).toBe(result.duration);
    act(() => hook.current.seek(-10));
    expect(hook.current.currentTime).toBe(0);
  });

  it('restart returns to zero', () => {
    const { result: hook } = renderHook(() => useSimulationPlayback(result));
    act(() => hook.current.seek(60));
    act(() => hook.current.restart());
    expect(hook.current.currentTime).toBe(0);
  });

  it('stepForward and stepBackward snap to step timestamps', () => {
    const { result: hook } = renderHook(() => useSimulationPlayback(result));
    act(() => hook.current.stepForward());
    expect(hook.current.currentTime).toBe(result.steps[1].timestamp);
    act(() => hook.current.stepForward());
    expect(hook.current.currentTime).toBe(result.steps[2].timestamp);
    act(() => hook.current.stepBackward());
    expect(hook.current.currentTime).toBe(result.steps[1].timestamp);
  });

  it('resets when the result identity changes', () => {
    const { result: hook, rerender } = renderHook(({ r }) => useSimulationPlayback(r), {
      initialProps: { r: result },
    });
    act(() => hook.current.seek(50));
    const next = runMockSimulation(coldChainScenario, 'hybrid');
    rerender({ r: next });
    expect(hook.current.currentTime).toBe(0);
  });
});

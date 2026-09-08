/**
 * Checkpoint 4 (causal chain) + Checkpoint 5 (cost of waiting).
 *
 * Both are derived entirely from real simulation output — event provenance and
 * repeated evaluation from later decision states.
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_INPUTS } from '../../domain';
import { costOfWaiting, runSimulation } from '../index';
import { buildCausalChain, primaryCausalPath } from '../../simulation/causalChain';
import { flagshipScenario, makeFlagshipScenario } from '../../simulation/scenarios/flagship';

describe('causal chain (CP4)', () => {
  const run = runSimulation(flagshipScenario, EMPTY_INPUTS, 'emergency_ship-a');
  if (!run.ok) throw new Error(run.error.message);
  const nodes = buildCausalChain(run.value.result);

  it('starts at the incident and reaches the decision', () => {
    expect(nodes[0].kind).toBe('incident');
    expect(nodes.some((n) => n.kind === 'decision')).toBe(true);
  });

  it('includes cascade nodes carrying their rule id and trigger source', () => {
    const cascade = nodes.filter((n) => n.kind === 'cascade');
    expect(cascade.length).toBeGreaterThanOrEqual(2);
    expect(cascade[0].ruleId).toBeDefined();
    expect(cascade.find((n) => n.ruleId === 'cascade-viability-risk')?.sourceId).toBe('viability');
  });

  it('links each downstream node to an upstream cause (no orphans past the root)', () => {
    for (const n of nodes.slice(1)) {
      if (n.kind === 'incident') continue;
      expect(n.causeId).toBeDefined();
      expect(nodes.some((m) => m.id === n.causeId)).toBe(true);
    }
  });

  it('the primary path is a real chain from incident to decision', () => {
    const path = primaryCausalPath(nodes);
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[0].kind).toBe('incident');
    expect(path[path.length - 1].kind).toBe('decision');
    // Consecutive: each node's cause is the previous node.
    for (let i = 1; i < path.length; i += 1) {
      expect(path[i].causeId).toBe(path[i - 1].id);
    }
  });

  it('a node points at a real map object', () => {
    const withAffected = nodes.find((n) => n.affectedId?.startsWith('ship-'));
    expect(withAffected).toBeDefined();
  });
});

describe('cost of waiting (CP5)', () => {
  it('reports one row per offset, each from a real evaluation', () => {
    const report = costOfWaiting(flagshipScenario, EMPTY_INPUTS, { offsets: [0, 10, 20, 30] });
    if (!report.ok) throw new Error(report.error.message);
    expect(report.value.rows.map((r) => r.offsetMinutes)).toEqual([0, 10, 20, 30]);
    expect(report.value.evaluations).toBe(4);
    for (const row of report.value.rows) {
      expect(row.feasibleStrategyIds.length).toBe(row.feasibleCount);
    }
  });

  it('waiting never expands the feasible option set', () => {
    const report = costOfWaiting(
      makeFlagshipScenario({ failing: ['ship-a', 'ship-b', 'ship-c'] }),
      EMPTY_INPUTS,
      { offsets: [0, 15, 30, 45, 60] },
    );
    if (!report.ok) throw new Error(report.error.message);
    const counts = report.value.rows.map((r) => r.feasibleCount);
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]).toBeLessThanOrEqual(counts[0]);
    }
  });

  it('is deterministic', () => {
    const a = costOfWaiting(flagshipScenario, EMPTY_INPUTS);
    const b = costOfWaiting(flagshipScenario, EMPTY_INPUTS);
    if (!a.ok || !b.ok) throw new Error('failed');
    expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
  });
});

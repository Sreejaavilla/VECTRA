import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { coldChainScenario, runMockSimulation } from '../../../simulation/mockEngine';
import { getStateAtTime } from '../../../simulation/selectors';
import { OperationalMap } from '../OperationalMap';
import { SimulationTimeline } from '../SimulationTimeline';
import { DecisionImpactPanel } from '../DecisionImpactPanel';
import { SimulationViewport } from '../SimulationViewport';

const result = runMockSimulation(coldChainScenario, 'emergency_interception');

describe('OperationalMap', () => {
  it('renders a facility label per facility and an entity per active entity', () => {
    const frame = getStateAtTime(result, 60);
    const { container } = render(
      <OperationalMap
        scenario={result.scenario}
        entities={frame.entities}
        activeRouteIds={frame.entities.map((e) => e.routeId).filter(Boolean) as string[]}
        completedRouteIds={[]}
        events={result.events.filter((e) => e.timestamp <= 60)}
        focus={frame.focus}
        selectedEntityId={null}
        onSelectEntity={() => {}}
      />,
    );
    for (const f of result.scenario.facilities) {
      expect(screen.getByText(f.label)).toBeInTheDocument();
    }
    const activeCount = frame.entities.filter((e) => e.active).length;
    expect(container.querySelectorAll('[role="button"]').length).toBe(activeCount);
  });
});

describe('SimulationTimeline', () => {
  it('renders a marker button per event and a NOW playhead', () => {
    render(
      <SimulationTimeline
        currentTime={40}
        duration={result.duration}
        events={result.events}
        onSeek={() => {}}
        onTogglePlay={() => {}}
        onStep={() => {}}
      />,
    );
    const markers = screen.getAllByRole('button');
    expect(markers.length).toBe(result.events.length);
    expect(screen.getByText(/NOW/)).toBeInTheDocument();
  });
});

describe('DecisionImpactPanel', () => {
  it('shows before and after columns', () => {
    render(<DecisionImpactPanel impact={result.decisionImpact!} scenario={result.scenario} reveal={1} />);
    expect(screen.getByText(/Before decision/i)).toBeInTheDocument();
    expect(screen.getByText(/After intervention/i)).toBeInTheDocument();
  });
});

describe('SimulationViewport states', () => {
  it('renders the empty state with no result', () => {
    render(<SimulationViewport result={null} onReplay={() => {}} />);
    expect(screen.getByText(/CAUSALIS Simulation/i)).toBeInTheDocument();
  });
  it('renders the error state', () => {
    render(<SimulationViewport result={null} error="boom" onReplay={() => {}} />);
    expect(screen.getByText(/Simulation failed/i)).toBeInTheDocument();
  });
  it('renders the run identity bar for a result', () => {
    render(<SimulationViewport result={result} onReplay={() => {}} />);
    expect(screen.getByText(/RUN #001/)).toBeInTheDocument();
  });
});

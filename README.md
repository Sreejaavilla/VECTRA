# VECTRA — CAUSALIS Simulation & Visualization Layer

Decision-simulation platform (hackathon PS7). This repository currently contains
the **Simulation Visualization & Interaction** layer: the operational map,
playback, timeline, charts, resource/event visualization and visual analytics.

The core decision engine, the main UI/UX control panel, and integration/deployment
are owned by other teammates.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest
npm run build    # tsc + vite build
```

## Architecture

```
ScenarioConfig + action ─► engine ─► SimulationResult (immutable)
                                            │
                        useSimulationPlayback ─► currentTime
                                            │
                        selectors.getStateAtTime(result, t)  (pure, interpolates)
                                            │
     OperationalMap · SimulationTimeline · MetricChart · panels
```

The visualization layer **never** computes domain metrics (temperature,
viability, scoring, feasibility). It only renders and interpolates what a
`SimulationResult` carries.

### Integration boundary

- `src/simulation/types.ts` — the `SimulationResult` contract the real engine
  must produce. Identity rule: everything is referenced by stable string id.
- `src/simulation/mockEngine.ts` — a **deterministic stand-in** implementing the
  contract for all four cold-chain strategies. Replace this file with the real
  engine; nothing else changes. `runMockSimulation(scenario, strategy, inputs)`
  is deterministic — identical inputs give an identical result (replay).
- `src/simulation/useSimulationPlayback.ts` — view-layer playback controller.
- `src/simulation/selectors.ts` — pure time/geometry/state selectors.
- `src/simulation/index.ts` — public surface for the integration engineer.

### Components (`src/components/simulation/`)

`SimulationViewport` composes everything and owns playback. It takes only
`result` (+ status flags). `OperationalMap` holds its SVG primitives.
`MetricChart` is generic (temperature and viability use the same component).
`App.tsx` is a throwaway demo harness standing in for the real control panel.

Press `d` in the viewport for a debug overlay.

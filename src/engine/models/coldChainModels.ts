/**
 * Cold-chain step models — a SIMPLIFIED DECISION-SUPPORT MODEL, not a
 * medical-grade thermal prediction. Every constant is supplied by the scenario;
 * nothing is hard-coded here and nothing is hard-coded in a React component.
 *
 * The causal chain these four models produce is the whole point of the product:
 *
 *   refrigeration failure -> temperature rises toward ambient
 *                         -> exposure accumulates above the safe threshold
 *                         -> viability degrades
 *                         -> risk band worsens
 *
 * and, symmetrically, an intervention that restores refrigeration bends
 * temperature back toward baseline and STOPS exposure accumulating. Nothing is
 * keyframed; the numbers fall out of the state transitions.
 */

import type { EntityRuntime, StepModel } from '../../domain';
import { shipmentPortions } from '../../domain';

export interface ColdChainModelConfig {
  baselineTemperature: number;
  ambientTemperature: number;
  safeTemperature: number;
  /** Exponential approach rate toward ambient while refrigeration is lost. */
  failureRatePerMin: number;
  /** Exponential approach rate toward baseline once refrigeration is restored. */
  recoveryRatePerMin: number;
  /** Viability points lost per degree-minute of exposure. */
  degradationRate: number;
  /** Nominal delivery minute used as the zero point for delay. */
  nominalDeliveryMinutes: number;
  /** End of the simulation horizon — a shipment still moving here never arrived. */
  horizonMinutes: number;
  /** Delay reported for a shipment that never completes delivery. */
  undeliveredDelayMinutes: number;
  /** Total demand across all hospitals, for the service-coverage metric. */
  totalDemandDoses: number;
  /** Viability bands, descending, mapped to risk scores 1..4. */
  riskBands: { low: number; moderate: number; high: number };
}

function carriesCargo(entity: EntityRuntime): boolean {
  for (const key of Object.keys(entity.payload)) {
    if (entity.payload[key] > 0) return true;
  }
  return false;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Exponential approach toward a target. Bounded by construction, so the model
 * cannot produce a runaway temperature no matter how long the horizon is.
 */
function approach(current: number, target: number, ratePerMin: number, dt: number): number {
  if (dt <= 0) return current;
  const factor = 1 - Math.exp(-ratePerMin * dt);
  return current + (target - current) * factor;
}

export function createTemperatureModel(config: ColdChainModelConfig): StepModel {
  return {
    id: 'model-temperature',
    step: (state, ctx) => {
      let worst: number | null = null;
      for (const key of Object.keys(state.entities).sort()) {
        const entity = state.entities[key];
        if (!carriesCargo(entity)) continue;
        const target = entity.refrigerated
          ? config.baselineTemperature
          : config.ambientTemperature;
        const rate = entity.refrigerated
          ? config.recoveryRatePerMin * entity.coolingEfficiency
          : config.failureRatePerMin;
        entity.cargoTemperature = approach(entity.cargoTemperature, target, rate, ctx.dt);
        worst = worst === null ? entity.cargoTemperature : Math.max(worst, entity.cargoTemperature);
      }
      // Once every portion has been delivered there is no cargo left to have a
      // temperature. Hold the last reported reading rather than snapping to
      // baseline, which would draw a recovery that never happened.
      if (worst !== null) state.metrics.temperature = worst;
      else if (state.metrics.temperature == null) {
        state.metrics.temperature = config.baselineTemperature;
      }
    },
  };
}

export function createExposureModel(config: ColdChainModelConfig): StepModel {
  return {
    id: 'model-exposure',
    step: (state, ctx) => {
      for (const key of Object.keys(state.entities).sort()) {
        const entity = state.entities[key];
        if (!carriesCargo(entity)) continue;
        const excess = Math.max(0, entity.cargoTemperature - config.safeTemperature);
        entity.cargoExposure += excess * ctx.dt;
      }
      // Dose-weighted mean across in-flight and settled portions. A portion that
      // reached cold storage stopped accumulating — that is what makes splitting
      // a shipment a genuinely different decision rather than a cosmetic one.
      const portions = shipmentPortions(state);
      const doses = portions.reduce((total, p) => total + p.doses, 0);
      state.exposure =
        doses === 0
          ? state.exposure
          : portions.reduce((total, p) => total + p.doses * p.exposure, 0) / doses;
      state.metrics.exposure = state.exposure;
    },
  };
}

export function createViabilityModel(config: ColdChainModelConfig): StepModel {
  return {
    id: 'model-viability',
    step: (state) => {
      const portions = shipmentPortions(state);
      const doses = portions.reduce((total, p) => total + p.doses, 0);
      if (doses === 0) return;
      const weighted = portions.reduce((total, p) => {
        const viability = clamp(100 - p.exposure * config.degradationRate, 0, 100);
        return total + p.doses * viability;
      }, 0);
      state.metrics.viability = weighted / doses;
    },
  };
}

export function createRiskModel(config: ColdChainModelConfig): StepModel {
  return {
    id: 'model-risk',
    step: (state) => {
      const viability = state.metrics.viability ?? 100;
      const { low, moderate, high } = config.riskBands;
      state.metrics.risk =
        viability >= low ? 1 : viability >= moderate ? 2 : viability >= high ? 3 : 4;
    },
  };
}

/** Cost accrues from resources the chosen action actually consumed. */
export function createCostModel(): StepModel {
  return {
    id: 'model-cost',
    step: (state) => {
      let cost = 0;
      for (const key of Object.keys(state.resources).sort()) {
        const resource = state.resources[key];
        const spent = Number(state.flags[`spend:${resource.id}`] ?? 0);
        cost += spent;
      }
      state.metrics.cost = cost;
    },
  };
}

/** Delay is measured against the scenario's nominal delivery time. */
export function createDelayModel(config: ColdChainModelConfig): StepModel {
  return {
    id: 'model-delay',
    step: (state, ctx) => {
      const outstanding = Object.keys(state.shipmentAllocations).reduce(
        (total, key) => total + state.shipmentAllocations[key],
        0,
      );
      if (outstanding <= 0) {
        // Everything has come to rest — freeze delay at the last settlement.
        const last = state.settled.reduce((max, p) => Math.max(max, p.atMinutes), 0);
        state.metrics.delay = Math.max(0, last - config.nominalDeliveryMinutes);
        return;
      }
      // A shipment still in transit at the end of the horizon never arrived —
      // report an unbounded delay so a hard delivery constraint can reject it.
      if (ctx.now >= config.horizonMinutes - 1e-6) {
        state.metrics.delay = config.undeliveredDelayMinutes;
        return;
      }
      state.metrics.delay = Math.max(0, ctx.now - config.nominalDeliveryMinutes);
    },
  };
}

/** Fraction of total demand that has been delivered to a hospital. */
export function createCoverageModel(config: ColdChainModelConfig): StepModel {
  return {
    id: 'model-coverage',
    step: (state) => {
      const delivered = state.settled
        .filter((p) => p.kind === 'delivered')
        .reduce((total, p) => total + p.doses, 0);
      state.metrics.serviceCoverage =
        config.totalDemandDoses <= 0
          ? 1
          : Math.min(1, delivered / config.totalDemandDoses);
    },
  };
}

export function createColdChainModels(config: ColdChainModelConfig): StepModel[] {
  // Order matters: temperature feeds exposure feeds viability feeds risk.
  return [
    createTemperatureModel(config),
    createExposureModel(config),
    createViabilityModel(config),
    createRiskModel(config),
    createCostModel(),
    createDelayModel(config),
    createCoverageModel(config),
  ];
}

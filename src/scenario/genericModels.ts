/**
 * Generic step models for user-built, non-pharma scenarios.
 *
 * Cost / delay / service-coverage are already domain-agnostic and are reused
 * from the engine's model file directly. Only the generic operational-risk
 * model is defined here. Temperature / exposure / viability stay cold-chain.
 */

import type { StepModel } from '../domain';
import {
  createCostModel,
  createDelayModel,
  createCoverageModel,
  type ColdChainModelConfig,
} from '../engine/models/coldChainModels';

export interface GenericModelConfig {
  nominalDeliveryMinutes: number;
  totalDemandDoses: number;
}

/**
 * Operational risk 0..4, derived from what the run is actually achieving:
 * undelivered demand dominates, a slipping delivery adds to it.
 */
export function createGenericRiskModel(_config: GenericModelConfig): StepModel {
  return {
    id: 'model-generic-risk',
    step: (state) => {
      const coverage = state.metrics.serviceCoverage ?? 0;
      const delay = state.metrics.delay ?? 0;
      const risk = 4 * (1 - coverage) + (delay > 30 ? 1 : delay > 0 ? 0.5 : 0);
      state.metrics.risk = Math.max(0, Math.min(4, risk));
    },
  };
}

export function createGenericModels(config: GenericModelConfig): StepModel[] {
  // The delay + coverage models only read these two fields; the rest of the
  // cold-chain config is inert for a generic scenario.
  const cfg: ColdChainModelConfig = {
    baselineTemperature: 0,
    ambientTemperature: 0,
    safeTemperature: 0,
    failureRatePerMin: 0,
    recoveryRatePerMin: 0,
    degradationRate: 0,
    nominalDeliveryMinutes: config.nominalDeliveryMinutes,
    totalDemandDoses: config.totalDemandDoses,
    riskBands: { low: 85, moderate: 70, high: 50 },
  };
  // Cost feeds nothing; delay + coverage feed risk. Order matters for risk.
  return [
    createCostModel(),
    createDelayModel(cfg),
    createCoverageModel(cfg),
    createGenericRiskModel(config),
  ];
}

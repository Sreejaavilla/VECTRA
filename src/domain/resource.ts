/**
 * Resources are the allocatable/consumable constraints of a scenario:
 * vehicles, storage capacity, budget, personnel.
 *
 * The engine owns every change to resource state. Actions declare what they
 * need; the engine decides whether that need can be met.
 */

export type ResourceStatus = 'available' | 'allocated' | 'depleted' | 'unavailable';

export type ResourceKind = 'boolean' | 'discrete' | 'consumable';

export interface ResourceDefinition {
  id: string;
  label: string;
  kind: ResourceKind;
  /** Boolean resources use 1 (available) / 0 (unavailable). */
  initial: number | boolean;
  capacity?: number;
  /** Cost per unit consumed; feeds a CostModel. */
  unitCost?: number;
  /** Formats `detail` on the render-facing ResourceState. */
  unit?: string;
  /** How the adapter renders `detail`. */
  detailFormat?: 'availability' | 'count' | 'currency-lakh';
}

export interface ResourceRequirement {
  resourceId: string;
  /** Boolean resources take `true`; consumables take a quantity. */
  amount: number | boolean;
}

/** Render-facing resource snapshot. Derived from the authoritative runtime state. */
export interface ResourceState {
  id: string;
  label: string;
  status: ResourceStatus;
  /** "4,200 / 5,000 doses", "₹3.2L of ₹8.0L remaining", etc. */
  detail?: string;
}

/** Normalize a definition's `initial` to the runtime numeric quantity. */
export function initialQuantity(definition: ResourceDefinition): number {
  if (typeof definition.initial === 'boolean') return definition.initial ? 1 : 0;
  return definition.initial;
}

/** Normalize a requirement's `amount` to a numeric quantity. */
export function requiredQuantity(requirement: ResourceRequirement): number {
  if (typeof requirement.amount === 'boolean') return requirement.amount ? 1 : 0;
  return requirement.amount;
}

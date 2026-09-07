/**
 * Structured engine failures. The engine never throws a bare string and never
 * logs; the UI maps these to human-readable messages.
 */

import type { ConstraintViolation } from '../domain';

export type EngineErrorKind =
  | 'InvalidScenario'
  | 'InvalidInput'
  | 'ConstraintViolation'
  | 'ResourceUnavailable'
  | 'SimulationFailure';

export interface EngineError {
  kind: EngineErrorKind;
  message: string;
  details?: ConstraintViolation[];
}

export type EngineResult<T> = { ok: true; value: T } | { ok: false; error: EngineError };

export function engineError(
  kind: EngineErrorKind,
  message: string,
  details?: ConstraintViolation[],
): EngineError {
  return { kind, message, details };
}

/** Thrown by the adapter boundary so React error handling stays idiomatic. */
export class EngineException extends Error {
  readonly error: EngineError;

  constructor(error: EngineError) {
    super(error.message);
    this.name = 'EngineException';
    this.error = error;
  }
}

export function unwrap<T>(result: EngineResult<T>): T {
  if (result.ok) return result.value;
  throw new EngineException(result.error);
}

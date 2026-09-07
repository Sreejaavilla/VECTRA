/**
 * Determinism primitives.
 *
 * The guarantee is: same scenario + inputs + strategy + seed + engineVersion
 * produces a STRUCTURALLY IDENTICAL result (deepEqual). Byte identity is not
 * claimed — `canonicalSerialize` exists for callers who want to assert the
 * stronger property explicitly.
 */

/** FNV-1a. Stable across platforms and runs. */
export function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * JSON with keys emitted in sorted order and floats rounded to a fixed
 * precision, so two structurally identical results serialize identically.
 */
export function canonicalSerialize(value: unknown, precision = 6): string {
  const factor = 10 ** precision;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) return String(node);
      return Math.round(node * factor) / factor;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const source = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        if (source[key] === undefined) continue;
        out[key] = walk(source[key]);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

/**
 * Derive a seed from everything that defines a run. Used when the caller does
 * not supply one, so ordinary runs are reproducible without anybody tracking a
 * seed value.
 */
export function deriveSeed(
  scenarioId: string,
  strategyId: string,
  inputs: unknown,
  engineVersion: string,
): number {
  return hashString(
    `${scenarioId}|${strategyId}|${canonicalSerialize(inputs)}|${engineVersion}`,
  );
}

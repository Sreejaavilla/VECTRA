/** Deterministic layered auto-layout. Same graph -> same positions. */

import type { ScenarioGraph } from '../../scenario';

export function autoLayout(graph: ScenarioGraph): ScenarioGraph {
  if (graph.nodes.length === 0) return graph;

  const incoming = new Map<string, number>();
  for (const n of graph.nodes) incoming.set(n.id, 0);
  for (const e of graph.edges) {
    if (e.available !== false) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  }

  // Layer = longest path from a source, computed by relaxation (deterministic).
  const layer = new Map<string, number>();
  for (const n of graph.nodes) layer.set(n.id, incoming.get(n.id) === 0 ? 0 : -1);
  const adj = new Map<string, string[]>();
  for (const e of [...graph.edges].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  for (let pass = 0; pass < graph.nodes.length + 1; pass += 1) {
    let changed = false;
    for (const from of [...adj.keys()].sort()) {
      const fl = layer.get(from);
      if (fl == null || fl < 0) continue;
      for (const to of adj.get(from)!) {
        if ((layer.get(to) ?? -1) < fl + 1) {
          layer.set(to, fl + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  for (const n of graph.nodes) if ((layer.get(n.id) ?? -1) < 0) layer.set(n.id, 0);

  const byLayer = new Map<number, string[]>();
  for (const n of [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const l = layer.get(n.id)!;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(n.id);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const maxLayer = Math.max(1, layers.length - 1);

  const nodes = graph.nodes.map((n) => {
    const l = layer.get(n.id)!;
    const col = byLayer.get(l)!;
    const row = col.indexOf(n.id);
    const x = 8 + (l / maxLayer) * 84;
    const y = col.length === 1 ? 30 : 8 + (row / (col.length - 1)) * 44;
    return { ...n, position: { x: Math.round(x), y: Math.round(y) } };
  });

  return { ...graph, nodes };
}

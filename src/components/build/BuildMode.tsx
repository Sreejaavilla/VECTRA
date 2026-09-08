/**
 * VECTRA BUILD — the visual scenario editor.
 *
 * The canvas is the operational world the user authors. Everything here is data
 * editing: it never simulates. RUN hands the compiled scenario to the existing
 * LiveConsole.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  NODE_PROPERTY_SCHEMA,
  compileScenarioGraph,
  createEdge,
  createNode,
  deserializeGraph,
  serializeGraph,
  validateGraph,
  type GraphEdge,
  type GraphNode,
  type NodeType,
  type ObjectivePreset,
  type ScenarioGraph,
} from '../../scenario';
import { autoLayout } from './layout';
import styles from './BuildMode.module.css';

type Tool = 'select' | 'add' | 'connect';

const NODE_TYPES: NodeType[] = [
  'hub',
  'supplier',
  'factory',
  'warehouse',
  'cold-storage',
  'hospital',
  'destination',
  'transfer-point',
  'vehicle-base',
];

const OBJECTIVES: { id: ObjectivePreset; label: string }[] = [
  { id: 'protect-product', label: 'Protect product' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'minimize-cost', label: 'Minimise cost' },
  { id: 'maximize-service', label: 'Maximise service' },
];

interface BuildModeProps {
  graph: ScenarioGraph;
  onGraphChange: (graph: ScenarioGraph) => void;
  onRun: (scenario: ReturnType<typeof compileScenarioGraph>) => void;
  onExitToLive: () => void;
  hasCompiled: boolean;
}

export function BuildMode({ graph, onGraphChange, onRun, onExitToLive, hasCompiled }: BuildModeProps) {
  const [tool, setTool] = useState<Tool>('select');
  const [addType, setAddType] = useState<NodeType>('hospital');
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [dirty, setDirty] = useState(false);

  const past = useRef<ScenarioGraph[]>([]);
  const future = useRef<ScenarioGraph[]>([]);
  const [hist, setHist] = useState({ canUndo: false, canRedo: false });
  const svgRef = useRef<SVGSVGElement>(null);
  const syncHist = () =>
    setHist({ canUndo: past.current.length > 0, canRedo: future.current.length > 0 });

  const commit = useCallback(
    (next: ScenarioGraph) => {
      past.current = [...past.current.slice(-40), graph];
      future.current = [];
      syncHist();
      setDirty(true);
      onGraphChange(next);
    },
    [graph, onGraphChange],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current = [graph, ...future.current];
    syncHist();
    setDirty(true);
    onGraphChange(prev);
  }, [graph, onGraphChange]);

  const redo = useCallback(() => {
    const next = future.current.shift();
    if (!next) return;
    past.current = [...past.current, graph];
    syncHist();
    setDirty(true);
    onGraphChange(next);
  }, [graph, onGraphChange]);

  const validation = useMemo(() => validateGraph(graph), [graph]);
  const compiled = useMemo(
    () => (validation.ok ? compileScenarioGraph(graph) : null),
    [graph, validation.ok],
  );

  /* --- canvas coordinate transform --- */
  const toGraphXY = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 106 - 3;
    const y = ((clientY - rect.top) / rect.height) * 72 - 6;
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(60, y)) };
  }, []);

  const onCanvasClick = (e: React.MouseEvent) => {
    if (tool === 'add') {
      const pos = toGraphXY(e.clientX, e.clientY);
      const node = createNode(graph, addType, pos);
      commit({ ...graph, nodes: [...graph.nodes, node] });
      setSelNode(node.id);
      setTool('select');
      return;
    }
    setSelNode(null);
    setSelEdge(null);
    setConnectFrom(null);
  };

  const onNodeClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tool === 'connect') {
      if (!connectFrom) {
        setConnectFrom(id);
      } else if (connectFrom !== id && !graph.edges.some((x) => x.from === connectFrom && x.to === id)) {
        commit({ ...graph, edges: [...graph.edges, createEdge(graph, connectFrom, id)] });
        setConnectFrom(null);
      }
      return;
    }
    setSelNode(id);
    setSelEdge(null);
  };

  /* --- node dragging --- */
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const onNodePointerDown = (id: string, e: React.PointerEvent) => {
    if (tool !== 'select') return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const node = graph.nodes.find((n) => n.id === id)!;
    const p = toGraphXY(e.clientX, e.clientY);
    dragRef.current = { id, dx: node.position.x - p.x, dy: node.position.y - p.y };
    past.current = [...past.current.slice(-40), graph];
    future.current = [];
  };
  const onCanvasPointerMove = (e: React.PointerEvent) => {
    const p = toGraphXY(e.clientX, e.clientY);
    if (connectFrom) setPointer(p);
    const d = dragRef.current;
    if (!d) return;
    const nodes = graph.nodes.map((n) =>
      n.id === d.id
        ? { ...n, position: { x: Math.round(p.x + d.dx), y: Math.round(p.y + d.dy) } }
        : n,
    );
    setDirty(true);
    onGraphChange({ ...graph, nodes });
  };
  const onCanvasPointerUp = () => {
    dragRef.current = null;
  };

  const deleteSelection = useCallback(() => {
    if (selNode) {
      commit({
        ...graph,
        nodes: graph.nodes.filter((n) => n.id !== selNode),
        edges: graph.edges.filter((e) => e.from !== selNode && e.to !== selNode),
        shipments: graph.shipments.filter(
          (s) => s.originId !== selNode && s.destinationId !== selNode,
        ),
      });
      setSelNode(null);
    } else if (selEdge) {
      commit({
        ...graph,
        edges: graph.edges.filter((e) => e.id !== selEdge),
        incidents: graph.incidents.filter((i) => i.targetId !== selEdge),
      });
      setSelEdge(null);
    }
  }, [graph, selNode, selEdge, commit]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
    else if (e.key === 'Escape') {
      setConnectFrom(null);
      setTool('select');
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
  };

  const runNow = () => {
    if (!compiled) return;
    setDirty(false);
    onRun(compiled);
  };

  const doExport = () => {
    const blob = new Blob([serializeGraph(graph)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${graph.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const importRef = useRef<HTMLInputElement>(null);
  const doImport = async (file: File) => {
    const parsed = deserializeGraph(await file.text());
    if (!parsed.ok || !parsed.graph) {
      alert(`Import failed: ${parsed.error}`);
      return;
    }
    past.current = [...past.current, graph];
    commit(parsed.graph);
  };

  const node = graph.nodes.find((n) => n.id === selNode) ?? null;
  const edge = graph.edges.find((e) => e.id === selEdge) ?? null;

  return (
    <div className={styles.build} tabIndex={0} onKeyDown={onKeyDown}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.mark}>VECTRA</span>
          <span className={styles.sub}>Build</span>
        </div>
        <div className={styles.tools}>
          <button className={tool === 'select' ? styles.on : ''} onClick={() => setTool('select')}>
            Select
          </button>
          <span className={styles.addGroup}>
            <button className={tool === 'add' ? styles.on : ''} onClick={() => setTool('add')}>
              Add
            </button>
            <select value={addType} onChange={(e) => setAddType(e.target.value as NodeType)}>
              {NODE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace('-', ' ')}
                </option>
              ))}
            </select>
          </span>
          <button className={tool === 'connect' ? styles.on : ''} onClick={() => setTool('connect')}>
            Connect
          </button>
          <button onClick={deleteSelection} disabled={!selNode && !selEdge}>
            Delete
          </button>
          <button onClick={() => commit(autoLayout(graph))}>Auto Layout</button>
          <button onClick={undo} disabled={!hist.canUndo}>
            Undo
          </button>
          <button onClick={redo} disabled={!hist.canRedo}>
            Redo
          </button>
        </div>
        <div className={styles.headerRight}>
          <button onClick={doExport}>Export</button>
          <button onClick={() => importRef.current?.click()}>Import</button>
          <input
            ref={importRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])}
          />
          {hasCompiled && (
            <button className={styles.ghost} onClick={onExitToLive}>
              ← Live
            </button>
          )}
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.canvasWrap}>
          <svg
            ref={svgRef}
            className={styles.canvas}
            viewBox="-3 -6 106 72"
            preserveAspectRatio="xMidYMid meet"
            onClick={onCanvasClick}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={onCanvasPointerUp}
            data-tool={tool}
          >
            <defs>
              <marker id="arw" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0 0 L9 5 L0 10 Z" fill="var(--text-2)" />
              </marker>
            </defs>

            {graph.edges.map((e) => (
              <EdgeShape
                key={e.id}
                edge={e}
                nodes={graph.nodes}
                selected={e.id === selEdge}
                onSelect={(id) => {
                  setSelEdge(id);
                  setSelNode(null);
                }}
              />
            ))}

            {connectFrom && pointer && (() => {
              const f = graph.nodes.find((n) => n.id === connectFrom);
              return f ? (
                <line
                  className={styles.previewLine}
                  x1={f.position.x}
                  y1={f.position.y}
                  x2={pointer.x}
                  y2={pointer.y}
                />
              ) : null;
            })()}

            {graph.nodes.map((n) => (
              <NodeShape
                key={n.id}
                node={n}
                selected={n.id === selNode}
                connecting={n.id === connectFrom}
                onClick={onNodeClick}
                onPointerDown={onNodePointerDown}
              />
            ))}

            {graph.nodes.length === 0 && (
              <text x={50} y={30} className={styles.empty} textAnchor="middle">
                Add nodes, connect them, define shipments — then Run.
              </text>
            )}
          </svg>

          <div className={`${styles.statusBar} ${validation.ok ? styles.ok : styles.bad}`}>
            <span className={styles.statusWord}>
              {validation.ok ? 'READY TO SIMULATE' : 'SCENARIO NEEDS ATTENTION'}
              {dirty && validation.ok && ' · modified'}
            </span>
            {validation.issues.slice(0, 3).map((i, k) => (
              <span key={k} className={i.severity === 'error' ? styles.issueErr : styles.issueWarn}>
                {i.severity === 'error' ? '✕' : '!'} {i.message}
              </span>
            ))}
            <button className={styles.run} onClick={runNow} disabled={!validation.ok}>
              Run Scenario
            </button>
          </div>
        </div>

        <aside className={styles.inspector}>
          {node ? (
            <NodeInspector
              node={node}
              onChange={(next) =>
                commit({ ...graph, nodes: graph.nodes.map((n) => (n.id === node.id ? next : n)) })
              }
            />
          ) : edge ? (
            <EdgeInspector
              edge={edge}
              nodes={graph.nodes}
              onChange={(next) =>
                commit({ ...graph, edges: graph.edges.map((e) => (e.id === edge.id ? next : e)) })
              }
            />
          ) : (
            <ScenarioInspector graph={graph} onChange={commit} info={compiled?.info} />
          )}
        </aside>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------- *
 * Canvas shapes
 * --------------------------------------------------------------------------- */

function NodeShape({
  node,
  selected,
  connecting,
  onClick,
  onPointerDown,
}: {
  node: GraphNode;
  selected: boolean;
  connecting: boolean;
  onClick: (id: string, e: React.MouseEvent) => void;
  onPointerDown: (id: string, e: React.PointerEvent) => void;
}) {
  const { x, y } = node.position;
  const cls = `${styles.node} ${styles[`t_${node.type.replace('-', '_')}`] ?? ''} ${
    selected ? styles.nodeSel : ''
  } ${connecting ? styles.nodeConnect : ''}`;
  const isDest = node.type === 'hospital' || node.type === 'destination';
  const isStore = node.type === 'cold-storage' || node.type === 'warehouse';
  return (
    <g
      className={cls}
      transform={`translate(${x} ${y})`}
      onClick={(e) => onClick(node.id, e)}
      onPointerDown={(e) => onPointerDown(node.id, e)}
      role="button"
      tabIndex={0}
    >
      {isStore ? (
        <rect x={-3} y={-3} width={6} height={6} rx={0.7} className={styles.nodeShape} />
      ) : isDest ? (
        <path d="M0 -3.4 L3 1.8 L-3 1.8 Z" className={styles.nodeShape} />
      ) : (
        <circle r={3} className={styles.nodeShape} />
      )}
      <text className={styles.nodeLabel} y={-4.6} textAnchor="middle">
        {node.name}
      </text>
    </g>
  );
}

function EdgeShape({
  edge,
  nodes,
  selected,
  onSelect,
}: {
  edge: GraphEdge;
  nodes: GraphNode[];
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const a = nodes.find((n) => n.id === edge.from);
  const b = nodes.find((n) => n.id === edge.to);
  if (!a || !b) return null;
  return (
    <g
      className={`${styles.edge} ${selected ? styles.edgeSel : ''} ${
        !edge.available ? styles.edgeBlocked : ''
      }`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(edge.id);
      }}
    >
      <line
        x1={a.position.x}
        y1={a.position.y}
        x2={b.position.x}
        y2={b.position.y}
        className={styles.edgeHit}
      />
      <line
        x1={a.position.x}
        y1={a.position.y}
        x2={b.position.x}
        y2={b.position.y}
        className={styles.edgeLine}
        markerEnd="url(#arw)"
      />
    </g>
  );
}

/* --------------------------------------------------------------------------- *
 * Inspectors
 * --------------------------------------------------------------------------- */

function NodeInspector({ node, onChange }: { node: GraphNode; onChange: (n: GraphNode) => void }) {
  const schema = NODE_PROPERTY_SCHEMA[node.type];
  return (
    <div className={styles.inspBody}>
      <span className="u-label">{node.type.replace('-', ' ')}</span>
      <Field label="Name">
        <input value={node.name} onChange={(e) => onChange({ ...node, name: e.target.value })} />
      </Field>
      {schema.map((f) => (
        <Field key={f.key} label={`${f.label}${f.unit ? ` (${f.unit})` : ''}`}>
          {f.kind === 'select' ? (
            <select
              value={String(node.props[f.key] ?? f.default)}
              onChange={(e) => onChange({ ...node, props: { ...node.props, [f.key]: e.target.value } })}
            >
              {f.options?.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : f.kind === 'boolean' ? (
            <input
              type="checkbox"
              checked={Boolean(node.props[f.key] ?? f.default)}
              onChange={(e) => onChange({ ...node, props: { ...node.props, [f.key]: e.target.checked } })}
            />
          ) : (
            <input
              type={f.kind === 'number' ? 'number' : 'text'}
              value={String(node.props[f.key] ?? f.default)}
              onChange={(e) =>
                onChange({
                  ...node,
                  props: {
                    ...node.props,
                    [f.key]: f.kind === 'number' ? Number(e.target.value) : e.target.value,
                  },
                })
              }
            />
          )}
        </Field>
      ))}
      <p className={styles.hint}>id: {node.id}</p>
    </div>
  );
}

function EdgeInspector({
  edge,
  nodes,
  onChange,
}: {
  edge: GraphEdge;
  nodes: GraphNode[];
  onChange: (e: GraphEdge) => void;
}) {
  const name = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;
  return (
    <div className={styles.inspBody}>
      <span className="u-label">Route</span>
      <p className={styles.routeTitle}>
        {name(edge.from)} → {name(edge.to)}
      </p>
      <Field label="Travel time (min)">
        <input
          type="number"
          value={edge.travelTimeMinutes}
          onChange={(e) => onChange({ ...edge, travelTimeMinutes: Number(e.target.value) })}
        />
      </Field>
      <Field label="Capacity">
        <input
          type="number"
          value={edge.capacity}
          onChange={(e) => onChange({ ...edge, capacity: Number(e.target.value) })}
        />
      </Field>
      <Field label="Cost (₹)">
        <input
          type="number"
          value={edge.cost}
          onChange={(e) => onChange({ ...edge, cost: Number(e.target.value) })}
        />
      </Field>
      <Field label="Available">
        <input
          type="checkbox"
          checked={edge.available}
          onChange={(e) => onChange({ ...edge, available: e.target.checked })}
        />
      </Field>
      <p className={styles.hint}>id: {edge.id}</p>
    </div>
  );
}

function ScenarioInspector({
  graph,
  onChange,
  info,
}: {
  graph: ScenarioGraph;
  onChange: (g: ScenarioGraph) => void;
  info?: ReturnType<typeof compileScenarioGraph>['info'];
}) {
  const addShipment = () => {
    const origin = graph.nodes[0]?.id;
    const dest = graph.nodes.find((n) => n.type === 'hospital' || n.type === 'destination')?.id;
    if (!origin || !dest) return;
    let n = 200;
    while (graph.shipments.some((s) => s.id === `VX-${n}`)) n += 1;
    onChange({
      ...graph,
      shipments: [
        ...graph.shipments,
        {
          id: `VX-${n}`,
          label: `Shipment VX-${n}`,
          originId: origin,
          destinationId: dest,
          quantity: 600,
          priority: 'normal',
          deadlineMinutes: 120,
          refrigerated: graph.domainModel === 'cold-chain',
        },
      ],
    });
  };
  const addIncident = () => {
    const edge = graph.edges[0]?.id;
    onChange({
      ...graph,
      incidents: [
        ...graph.incidents,
        {
          id: `inc-${graph.incidents.length + 1}`,
          atMinutes: 35,
          type: graph.domainModel === 'cold-chain' ? 'refrigeration-failure' : 'route-blockage',
          targetId: graph.domainModel === 'cold-chain' ? undefined : edge,
          severity: 'high',
        },
      ],
    });
  };

  return (
    <div className={styles.inspBody}>
      <span className="u-label">Scenario</span>
      <Field label="Name">
        <input value={graph.name} onChange={(e) => onChange({ ...graph, name: e.target.value })} />
      </Field>
      <Field label="Objective">
        <select
          value={graph.objective}
          onChange={(e) => onChange({ ...graph, objective: e.target.value as ObjectivePreset })}
        >
          {OBJECTIVES.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Duration (min)">
        <input
          type="number"
          value={graph.durationMinutes}
          onChange={(e) => onChange({ ...graph, durationMinutes: Number(e.target.value) })}
        />
      </Field>

      <div className={styles.sub2}>
        <span className="u-label">Shipments ({graph.shipments.length})</span>
        <button onClick={addShipment}>+ add</button>
      </div>
      {graph.shipments.map((s) => (
        <div key={s.id} className={styles.listRow}>
          <input
            className={styles.listName}
            value={s.label}
            onChange={(e) =>
              onChange({
                ...graph,
                shipments: graph.shipments.map((x) =>
                  x.id === s.id ? { ...x, label: e.target.value } : x,
                ),
              })
            }
          />
          <select
            value={s.priority}
            onChange={(e) =>
              onChange({
                ...graph,
                shipments: graph.shipments.map((x) =>
                  x.id === s.id
                    ? { ...x, priority: e.target.value as typeof s.priority }
                    : x,
                ),
              })
            }
          >
            <option value="critical">critical</option>
            <option value="high">high</option>
            <option value="normal">normal</option>
          </select>
          <select
            value={s.destinationId}
            onChange={(e) =>
              onChange({
                ...graph,
                shipments: graph.shipments.map((x) =>
                  x.id === s.id ? { ...x, destinationId: e.target.value } : x,
                ),
              })
            }
          >
            {graph.nodes
              .filter((n) => n.type === 'hospital' || n.type === 'destination')
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
          </select>
          <button
            onClick={() =>
              onChange({ ...graph, shipments: graph.shipments.filter((x) => x.id !== s.id) })
            }
          >
            ✕
          </button>
        </div>
      ))}

      <div className={styles.sub2}>
        <span className="u-label">Incidents ({graph.incidents.length})</span>
        <button onClick={addIncident}>+ add</button>
      </div>
      {graph.incidents.map((inc) => (
        <div key={inc.id} className={styles.listRow}>
          <select
            value={inc.type}
            onChange={(e) =>
              onChange({
                ...graph,
                incidents: graph.incidents.map((x) =>
                  x.id === inc.id ? { ...x, type: e.target.value as typeof inc.type } : x,
                ),
              })
            }
          >
            <option value="refrigeration-failure">refrigeration failure</option>
            <option value="route-blockage">route blockage</option>
            <option value="resource-unavailable">resource unavailable</option>
            <option value="storage-reduction">storage reduction</option>
          </select>
          <input
            className={styles.listNum}
            type="number"
            value={inc.atMinutes}
            onChange={(e) =>
              onChange({
                ...graph,
                incidents: graph.incidents.map((x) =>
                  x.id === inc.id ? { ...x, atMinutes: Number(e.target.value) } : x,
                ),
              })
            }
          />
          {inc.type === 'route-blockage' && (
            <select
              value={inc.targetId ?? ''}
              onChange={(e) =>
                onChange({
                  ...graph,
                  incidents: graph.incidents.map((x) =>
                    x.id === inc.id ? { ...x, targetId: e.target.value } : x,
                  ),
                })
              }
            >
              <option value="">(route)</option>
              {graph.edges.map((ed) => (
                <option key={ed.id} value={ed.id}>
                  {ed.id}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() =>
              onChange({ ...graph, incidents: graph.incidents.filter((x) => x.id !== inc.id) })
            }
          >
            ✕
          </button>
        </div>
      ))}

      {info && (
        <p className={styles.hint}>
          {info.domainModel} · {info.facilities} nodes · {info.routes} routes ·{' '}
          {info.alternatePaths} alternate path{info.alternatePaths === 1 ? '' : 's'}
        </p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}

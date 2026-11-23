import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Empty, Input, Select, Spin } from "antd";
import { Card } from "../../components/ui/Card";
import type {
  MemoryGraph,
  MemoryGraphNode,
} from "../../../../shared/memory-graph";
import "./memory-graph.css";

const colors = {
  记忆: "#8266b3",
  实体: "#148777",
  主题: "#917743",
  出处: "#4685ac",
  表达: "#b56385",
  会话: "#477392",
};
const empty: MemoryGraph = { nodes: [], edges: [] };
const cap = 240;

export default function MemoryGraphPanel({
  onWiki,
}: {
  onWiki: (id: string) => void;
}) {
  const [graph, setGraph] = useState(empty),
    [revision, refresh] = useState(0);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(""),
    [kind, setKind] = useState("全部"),
    [selected, select] = useState("");
  const [timeline, setTimeline] = useState(false),
    [limit, setLimit] = useState(40);
  const [view, setView] = useState({ yaw: 0, pitch: 0, zoom: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    setGraph(empty);
    if (!window.memoryPanel?.getGraph) {
      setLoading(false);
      setError("当前宿主未提供图谱接口");
      return;
    }
    window.memoryPanel
      .getGraph()
      .then(
        (result) => {
          if (alive) setGraph(result);
        },
        (err) => {
          if (alive) setError(String(err.message ?? err));
        },
      )
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [revision]);
  const byId = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph],
  );
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return graph.nodes
      .filter(
        (n) =>
          (kind === "全部" || kind === n.kind) &&
          (!q || (n.label + " " + (n.detail ?? "")).toLowerCase().includes(q)),
      )
      .sort((a, b) =>
        timeline
          ? (b.at ?? 0) - (a.at ?? 0) || a.id.localeCompare(b.id)
          : a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
      );
  }, [graph, query, kind, timeline]);
  const current = byId.get(selected);
  const neighbors = useMemo(
    () =>
      graph.edges
        .filter((edge) => edge.from === selected || edge.to === selected)
        .map((edge) => ({
          edge,
          node: byId.get(edge.from === selected ? edge.to : edge.from)!,
        })),
    [graph, selected, byId],
  );
  const points = useMemo(() => {
    const visible = new Map<string, MemoryGraphNode>();
    for (const node of [
      ...(current ? [current] : []),
      ...neighbors.map((n) => n.node),
      ...rows,
    ]) {
      visible.set(node.id, node);
      if (visible.size >= cap) break;
    }
    const set = Array.from(visible.values()).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    return set
      .map((node, i) => {
        const y = 1 - ((i + 0.5) * 2) / set.length,
          r = Math.sqrt(1 - y * y),
          theta = i * 2.399963 + view.yaw;
        const x = r * Math.cos(theta),
          z = r * Math.sin(theta),
          py = y * Math.cos(view.pitch) - z * Math.sin(view.pitch),
          pz = y * Math.sin(view.pitch) + z * Math.cos(view.pitch);
        const scale = (view.zoom * 1.95) / (2.7 - pz);
        return {
          node,
          x: 300 + 150 * x * scale,
          y: 170 + 134 * py * scale,
          z: pz,
          size: 4 + scale * 2.5,
        };
      })
      .sort((a, b) => a.z - b.z);
  }, [rows, neighbors, current, view]);
  const coords = new Map(points.map((p) => [p.node.id, p]));
  const zoom = (delta: number) =>
    setView((v) => ({
      ...v,
      zoom: Math.min(2.4, Math.max(0.5, v.zoom + delta)),
    }));
  const change = (id: string) => {
    select(id);
    setError("");
  };
  return (
    <Card>
      <section className="cy-memory-graph" aria-label="记忆图谱">
        <header>
          <h3>记忆图谱</h3>
          <Button onClick={() => refresh((n) => n + 1)}>刷新</Button>
        </header>
        <div className="cy-memory-graph-controls">
          <Input
            aria-label="搜索记忆"
            placeholder="搜索名字、原话或出处"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(40);
              select("");
            }}
          />
          <Select
            aria-label="节点类型"
            value={kind}
            options={["全部", ...Object.keys(colors)].map((value) => ({
              value,
              label: value,
            }))}
            onChange={(v) => {
              setKind(v);
              select("");
              setLimit(40);
            }}
          />
          <Button onClick={() => setTimeline(!timeline)}>
            {timeline ? "球形图" : "时间轴"}
          </Button>
        </div>
        {error && <Alert type="error" message={error} />}
        {loading ? (
          <Spin />
        ) : rows.length === 0 ? (
          <Empty description="没有匹配的记忆" />
        ) : (
          <>
            {!timeline && (
              <>
                <svg
                  viewBox="0 0 600 340"
                  aria-label="拖动旋转记忆图谱"
                  onWheel={(e) => zoom(e.deltaY < 0 ? 0.1 : -0.1)}
                  onPointerDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    drag.current = { x: e.clientX, y: e.clientY };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerUp={() => {
                    drag.current = null;
                  }}
                  onPointerCancel={() => {
                    drag.current = null;
                  }}
                  onPointerMove={(e) => {
                    if (!drag.current) return;
                    const dx = e.clientX - drag.current.x,
                      dy = e.clientY - drag.current.y;
                    drag.current = { x: e.clientX, y: e.clientY };
                    setView((v) => ({
                      ...v,
                      yaw: v.yaw + dx * 0.012,
                      pitch: v.pitch + dy * 0.012,
                    }));
                  }}
                >
                  {graph.edges.map((edge) => {
                    const a = coords.get(edge.from),
                      b = coords.get(edge.to);
                    if (!a || !b) return null;
                    const active =
                      edge.from === selected || edge.to === selected;
                    return (
                      <line
                        key={JSON.stringify(edge)}
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        stroke="currentColor"
                        opacity={active ? 0.75 : 0.12}
                        strokeDasharray={edge.weak ? "3 4" : undefined}
                      />
                    );
                  })}
                  {points.map((p) => (
                    <g key={p.node.id} onClick={() => change(p.node.id)}>
                      <title>{p.node.label}</title>
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={p.size}
                        fill={colors[p.node.kind]}
                        opacity={0.65 + 0.17 * (1 + p.z)}
                        stroke={
                          p.node.id === selected ? "currentColor" : "none"
                        }
                      />
                      {(p.node.id === selected || points.length < 10) && (
                        <text x={p.x + 9} y={p.y + 4}>
                          {p.node.label.slice(0, 18)}
                        </text>
                      )}
                    </g>
                  ))}
                </svg>
                <div className="cy-memory-graph-controls">
                  <Button aria-label="缩小" onClick={() => zoom(-0.2)}>
                    −
                  </Button>
                  <Button aria-label="放大" onClick={() => zoom(0.2)}>
                    ＋
                  </Button>
                  <small>
                    {points.length} 个可见节点 · 共 {graph.nodes.length} 个
                  </small>
                </div>
              </>
            )}
            <div className="cy-memory-graph-results">
              {rows.slice(0, limit).map((n) => (
                <button
                  type="button"
                  aria-pressed={selected === n.id}
                  key={n.id}
                  onClick={() => change(n.id)}
                >
                  {timeline && (
                    <time>
                      {n.at
                        ? new Date(n.at).toLocaleDateString()
                        : "日期未知"}{" "}
                    </time>
                  )}
                  {n.kind} · {n.label}
                </button>
              ))}
            </div>
            {rows.length > limit && (
              <Button onClick={() => setLimit((n) => n + 60)}>显示更多</Button>
            )}
          </>
        )}
        {current && (
          <aside>
            <h4>{current.label}</h4>
            {current.detail && <p>{current.detail}</p>}
            {current.url && (
              <a
                href={current.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  if (!window.system?.openExternal) return;
                  e.preventDefault();
                  void window.system
                    .openExternal(current.url!)
                    .catch((err) => setError(String(err)));
                }}
              >
                打开原始出处
              </a>
            )}
            {current.wikiId && (
              <Button onClick={() => onWiki(current.wikiId!)}>
                查看或更正 Wiki 记录
              </Button>
            )}
            {current.conversationId && (
              <Button
                onClick={() => {
                  const store = (
                    window as typeof window & {
                      chatStore?: {
                        openInReactChatWindow: (id: string) => Promise<unknown>;
                      };
                    }
                  ).chatStore;
                  void store
                    ?.openInReactChatWindow(current.conversationId!)
                    .catch((e) => setError(String(e)));
                }}
              >
                打开原对话
              </Button>
            )}
            {neighbors.map(({ edge, node }) => (
              <button
                key={JSON.stringify(edge)}
                onClick={() => change(node.id)}
              >
                {edge.label} · {node.label}
              </button>
            ))}
          </aside>
        )}
      </section>
    </Card>
  );
}

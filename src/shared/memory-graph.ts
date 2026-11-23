export type GraphKind = "记忆" | "实体" | "主题" | "出处" | "表达" | "会话";
export interface MemoryGraphNode {
  id: string;
  kind: GraphKind;
  label: string;
  detail?: string;
  at?: number;
  url?: string;
  conversationId?: string;
  wikiId?: string;
}
export interface MemoryGraphEdge {
  from: string;
  to: string;
  label: string;
  weak?: boolean;
}
export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}
export interface ExpressionSample {
  id: string;
  source: string;
  quote: string;
  scene: string;
  at: number;
}
export function graphBuilder() {
  const nodes = new Map<string, MemoryGraphNode>();
  const edges = new Map<string, MemoryGraphEdge>();
  return {
    add(node: MemoryGraphNode) {
      nodes.set(node.id, node);
      return node.id;
    },
    link(from: string, to: string, label: string, weak = false) {
      if (from !== to)
        edges.set(JSON.stringify([from, to, label]), { from, to, label, weak });
    },
    finish(): MemoryGraph {
      return {
        nodes: [...nodes.values()],
        edges: [...edges.values()].filter(
          (e) => nodes.has(e.from) && nodes.has(e.to),
        ),
      };
    },
  };
}

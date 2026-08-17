import type { GraphData } from '../api';

interface GraphCanvasProps {
  graph: GraphData;
  compact?: boolean;
  onSelectNode?: (label: string) => void;
}

interface Point {
  x: number;
  y: number;
}

function positionMap(graph: GraphData, compact: boolean): Map<string, Point> {
  const points = new Map<string, Point>();
  if (graph.nodes.length === 0) return points;
  const focusNode = graph.nodes.find((node) => node.emphasis) ?? graph.nodes[0];
  const width = compact ? 270 : 760;
  const height = compact ? 280 : 430;
  const center: Point = compact ? { x: width / 2, y: 140 } : { x: width / 2, y: height / 2 };
  points.set(focusNode.id, center);

  const others = graph.nodes.filter((node) => node.id !== focusNode.id);
  const radiusX = compact ? 96 : 220;
  const radiusY = compact ? 92 : 150;
  others.forEach((node, index) => {
    const angle = (-Math.PI / 2) + (index * (Math.PI * 2)) / Math.max(others.length, 1);
    points.set(node.id, {
      x: center.x + Math.cos(angle) * radiusX,
      y: center.y + Math.sin(angle) * radiusY,
    });
  });
  return points;
}

function visibleGraph(graph: GraphData, compact: boolean): GraphData {
  if (!compact || graph.nodes.length <= 4) return graph;
  const focus = graph.nodes.find((node) => node.emphasis) ?? graph.nodes[0];
  const neighborIds = new Set<string>([focus.id]);
  for (const link of graph.links) {
    if (link.from === focus.id) neighborIds.add(link.to);
    if (link.to === focus.id) neighborIds.add(link.from);
    if (neighborIds.size >= 4) break;
  }
  const nodes = [focus, ...graph.nodes.filter((node) =>
    node.id !== focus.id && neighborIds.has(node.id)
  )].slice(0, 4);
  const ids = new Set(nodes.map((node) => node.id));
  return {
    ...graph,
    nodes,
    links: graph.links.filter((link) => ids.has(link.from) && ids.has(link.to)),
  };
}

function nodeWidth(label: string): number {
  return Math.max(82, Math.min(160, 28 + label.length * 10));
}

export function GraphCanvas({ graph, compact = false, onSelectNode }: GraphCanvasProps) {
  if (graph.nodes.length === 0) {
    return (
      <div className={`graph-canvas graph-canvas--empty${compact ? ' graph-canvas--compact' : ''}`}>
        <p>No graph focus loaded yet.</p>
      </div>
    );
  }

  const rendered = visibleGraph(graph, compact);
  const width = compact ? 270 : 760;
  const height = compact ? 280 : 430;
  const positions = positionMap(rendered, compact);

  return (
    <div className={`graph-canvas${compact ? ' graph-canvas--compact' : ''}`}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Knowledge graph"
      >
        <title>Knowledge graph</title>
        <desc>
          Local-first entity relationships visualized as linked nodes. Use the relationship
          list below for a complete accessible summary.
        </desc>
        {rendered.links.map((link) => {
          const from = positions.get(link.from);
          const to = positions.get(link.to);
          if (!from || !to) return null;
          const labelX = (from.x + to.x) / 2;
          const labelY = (from.y + to.y) / 2 - 8;
          return (
            <g key={link.id}>
              <line
                className="graph-canvas__link"
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              />
              <text className="graph-canvas__edge-label" x={labelX} y={labelY}>
                {link.label}
              </text>
            </g>
          );
        })}
        {rendered.nodes.map((node) => {
          const point = positions.get(node.id);
          if (!point) return null;
          const widthValue = nodeWidth(node.label);
          const heightValue = 44;
          const x = point.x - widthValue / 2;
          const y = point.y - heightValue / 2;
          const className = node.emphasis
            ? 'graph-canvas__node graph-canvas__node--focus'
            : 'graph-canvas__node';
          return (
            <g
              key={node.id}
              className={className}
              role={onSelectNode ? 'button' : undefined}
              tabIndex={onSelectNode ? 0 : undefined}
              aria-label={onSelectNode ? `Focus ${node.label}` : undefined}
              onClick={onSelectNode ? () => onSelectNode(node.label) : undefined}
              onKeyDown={
                onSelectNode
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelectNode(node.label);
                      }
                    }
                  : undefined
              }
            >
              <rect x={x} y={y} rx="12" ry="12" width={widthValue} height={heightValue} />
              <text className="graph-canvas__node-label" x={point.x} y={point.y + 5}>
                {node.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

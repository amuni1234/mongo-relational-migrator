import { useLayoutEffect, useMemo, useRef, useState } from "react";
import ErTableCard from "./ErTableCard.jsx";
import { buildEdges, computeTiers, orderWithinTiers } from "../lib/erDiagramLayout.js";

// Spreads sibling edges evenly across a card's edge width instead of
// anchoring them all at dead-center, so multiple edges into/out of the same
// card don't visually overlap into one line.
function anchorX(pos, index, total) {
  return pos.x + (pos.width * (index + 1)) / (total + 1);
}

export default function ErDiagram({ schema }) {
  const containerRef = useRef(null);
  const cardRefs = useRef(new Map());
  const [positions, setPositions] = useState(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const { edges, selfEdges, tiers } = useMemo(() => {
    const { edges, selfEdges } = buildEdges(schema.tables);
    const tiers = orderWithinTiers(computeTiers(schema.tables, edges), edges);
    return { edges, selfEdges, tiers };
  }, [schema]);

  // Measure after render rather than precomputing heights from CSS
  // constants -- card height varies with column count, and a hand-derived
  // formula would have to be kept in sync with styles.css by hand forever.
  // Re-measures once more after web fonts finish loading, since a late font
  // swap (IBM Plex Sans/Mono) can shift layout by a few px after first paint.
  useLayoutEffect(() => {
    function measure() {
      const next = {};
      for (const [name, el] of cardRefs.current) {
        if (!el) continue;
        next[name] = {
          x: el.offsetLeft,
          y: el.offsetTop,
          width: el.offsetWidth,
          height: el.offsetHeight,
        };
      }
      setPositions(next);
      if (containerRef.current) {
        setCanvasSize({
          width: containerRef.current.scrollWidth,
          height: containerRef.current.scrollHeight,
        });
      }
    }
    measure();
    document.fonts?.ready?.then(measure);
  }, [schema, tiers]);

  // Group edges by their "from"/"to" card so sibling edges on the same card
  // can be spread across that card's edge width (see anchorX above).
  const outgoingGroups = new Map();
  const incomingGroups = new Map();
  for (const edge of edges) {
    if (!outgoingGroups.has(edge.from)) outgoingGroups.set(edge.from, []);
    outgoingGroups.get(edge.from).push(edge);
    if (!incomingGroups.has(edge.to)) incomingGroups.set(edge.to, []);
    incomingGroups.get(edge.to).push(edge);
  }

  return (
    <div className="er-diagram" ref={containerRef}>
      {tiers.map((tier, tierIndex) => (
        <div className="er-diagram-tier" key={tierIndex}>
          {tier.map((name) => {
            const table = schema.tables.find((t) => t.name === name);
            return (
              <ErTableCard
                key={name}
                table={table}
                ref={(el) => {
                  if (el) cardRefs.current.set(name, el);
                  else cardRefs.current.delete(name);
                }}
              />
            );
          })}
        </div>
      ))}

      {positions && (
        <svg className="er-diagram-lines" width={canvasSize.width} height={canvasSize.height}>
          <defs>
            <marker
              id="er-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="er-arrowhead" />
            </marker>
          </defs>

          {edges.map((edge, i) => {
            const fromPos = positions[edge.from];
            const toPos = positions[edge.to];
            if (!fromPos || !toPos) return null;

            const fromSiblings = outgoingGroups.get(edge.from) || [];
            const toSiblings = incomingGroups.get(edge.to) || [];
            const fromIdx = fromSiblings.indexOf(edge);
            const toIdx = toSiblings.indexOf(edge);

            // Child (from) sits in a lower tier than parent (to) in the
            // common case, so the edge exits the child's TOP edge and
            // arrives at the parent's BOTTOM edge. Same-tier edges (only
            // possible inside a cycle-dump tier) still draw reasonably --
            // the vertical control-point offset below produces a small arc
            // rather than a degenerate straight horizontal line.
            const x1 = anchorX(fromPos, fromIdx, fromSiblings.length);
            const y1 = fromPos.y;
            const x2 = anchorX(toPos, toIdx, toSiblings.length);
            const y2 = toPos.y + toPos.height;

            const dy = Math.max(Math.abs(y1 - y2) / 2, 30);
            const c1x = x1;
            const c1y = y1 - dy;
            const c2x = x2;
            const c2y = y2 + dy;

            return (
              <g key={i}>
                <path
                  d={`M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`}
                  className={edge.synthetic ? "er-edge synthetic" : "er-edge"}
                  markerEnd="url(#er-arrow)"
                />
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2} className="er-fk-label">
                  {edge.column}
                </text>
              </g>
            );
          })}

          {selfEdges.map((edge, i) => {
            const pos = positions[edge.from];
            if (!pos) return null;
            // Small loop bulging out from the right edge back to the top
            // edge -- only needs its own card's bounding box.
            const x1 = pos.x + pos.width;
            const y1 = pos.y + pos.height * 0.35;
            const x2 = pos.x + pos.width * 0.75;
            const y2 = pos.y;
            const bulge = 40;
            return (
              <g key={`self-${i}`}>
                <path
                  d={`M ${x1} ${y1} C ${x1 + bulge} ${y1}, ${x2 + bulge} ${y2}, ${x2} ${y2}`}
                  className={edge.synthetic ? "er-edge synthetic" : "er-edge"}
                  markerEnd="url(#er-arrow)"
                />
                <text x={x1 + bulge / 2} y={(y1 + y2) / 2} className="er-fk-label">
                  {edge.column}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

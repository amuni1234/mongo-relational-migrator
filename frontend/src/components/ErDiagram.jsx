import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ErTableCard from "./ErTableCard.jsx";
import { buildEdges, computeTiers, orderWithinTiers } from "../lib/erDiagramLayout.js";

// Anchor point on a row's card edge (left/right, not top/bottom) at the
// row's own vertical center -- lets different columns on the same card
// naturally land at different points without needing artificial spreading.
function rowAnchor(rowPos, cardPos, side) {
  return {
    x: side === "right" ? cardPos.x + cardPos.width : cardPos.x,
    y: rowPos.y + rowPos.height / 2,
  };
}

// Exit the card that's positioned further left from its right edge, enter
// the one further right from its left edge (and vice versa) -- a simple
// left/right routing rule, not full orthogonal routing.
function pickSides(fromCardPos, toCardPos) {
  const fromCenter = fromCardPos.x + fromCardPos.width / 2;
  const toCenter = toCardPos.x + toCardPos.width / 2;
  return fromCenter <= toCenter
    ? { fromSide: "right", toSide: "left" }
    : { fromSide: "left", toSide: "right" };
}

function bezierPath(fromAnchor, toAnchor, fromSide, toSide, bulge = 60) {
  const c1x = fromAnchor.x + (fromSide === "right" ? bulge : -bulge);
  const c2x = toAnchor.x + (toSide === "right" ? bulge : -bulge);
  return `M ${fromAnchor.x} ${fromAnchor.y} C ${c1x} ${fromAnchor.y}, ${c2x} ${toAnchor.y}, ${toAnchor.x} ${toAnchor.y}`;
}

// A computed column has no real source column, so it can never be a
// sensible relationship endpoint. ErTableCard.jsx already skips attaching
// onMouseDown for one (so a drag can't *start* there), but elementFromPoint
// in handleMouseMove/handleMouseUp below finds whatever DOM node is under
// the cursor regardless of that -- so a drag started from a real column
// could still be *dropped* onto a computed one without this second check.
function isComputedColumn(schema, tableName, columnName) {
  const table = schema.tables.find((t) => t.name === tableName);
  const column = table?.columns.find((c) => c.name === columnName);
  return !!column?.computed;
}

export default function ErDiagram({ schema, onAddForeignKey, onRemoveForeignKey }) {
  const containerRef = useRef(null);
  const cardRefs = useRef(new Map());
  const rowRefs = useRef(new Map()); // key: `${table}::${column}`

  const [positions, setPositions] = useState(null);
  const [rowPositions, setRowPositions] = useState(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const [dragStart, setDragStart] = useState(null); // { table, column }
  const [cursorPos, setCursorPos] = useState(null); // { x, y }
  const [hoverTarget, setHoverTarget] = useState(null); // { table, column }
  const [pendingConnection, setPendingConnection] = useState(null);
  const [hoveredEdgeIndex, setHoveredEdgeIndex] = useState(null);

  const { edges, selfEdges, tiers } = useMemo(() => {
    const { edges, selfEdges } = buildEdges(schema.tables);
    const tiers = orderWithinTiers(computeTiers(schema.tables, edges), edges);
    return { edges, selfEdges, tiers };
  }, [schema]);

  // Measure cards relative to .er-diagram (their positioned ancestor), then
  // rows relative to their own card (each card is itself `position:
  // relative`, so a row's offsetTop/offsetLeft are naturally relative to
  // it, not to .er-diagram) -- combine to get each row's absolute position.
  useLayoutEffect(() => {
    function measure() {
      const nextCards = {};
      for (const [name, el] of cardRefs.current) {
        if (!el) continue;
        nextCards[name] = {
          x: el.offsetLeft,
          y: el.offsetTop,
          width: el.offsetWidth,
          height: el.offsetHeight,
        };
      }
      setPositions(nextCards);

      const nextRows = {};
      for (const [key, el] of rowRefs.current) {
        if (!el) continue;
        const table = key.split("::")[0];
        const cardPos = nextCards[table];
        if (!cardPos) continue;
        nextRows[key] = {
          x: cardPos.x + el.offsetLeft,
          y: cardPos.y + el.offsetTop,
          width: el.offsetWidth,
          height: el.offsetHeight,
        };
      }
      setRowPositions(nextRows);

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

  function toContentCoords(e) {
    const rect = containerRef.current.getBoundingClientRect();
    return {
      x: e.clientX - rect.left + containerRef.current.scrollLeft,
      y: e.clientY - rect.top + containerRef.current.scrollTop,
    };
  }

  function handleRowMouseDown(table, column, e) {
    e.preventDefault();
    setDragStart({ table, column });
    setCursorPos(toContentCoords(e));
  }

  // Global listeners only exist while an actual drag is in progress.
  useEffect(() => {
    if (!dragStart) return;

    function handleMouseMove(e) {
      setCursorPos(toContentCoords(e));
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-table][data-column]");
      const target = el ? { table: el.dataset.table, column: el.dataset.column } : null;
      setHoverTarget(target && !isComputedColumn(schema, target.table, target.column) ? target : null);
    }

    function handleMouseUp(e) {
      const coords = toContentCoords(e);
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-table][data-column]");
      if (el) {
        const toTable = el.dataset.table;
        const toColumn = el.dataset.column;
        const isSameRow = toTable === dragStart.table && toColumn === dragStart.column;
        if (!isSameRow && !isComputedColumn(schema, toTable, toColumn)) {
          setPendingConnection({
            fromTable: dragStart.table,
            fromColumn: dragStart.column,
            toTable,
            toColumn,
            unique: false,
            x: coords.x,
            y: coords.y,
          });
        }
      }
      setDragStart(null);
      setCursorPos(null);
      setHoverTarget(null);
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragStart]);

  function confirmConnection() {
    // Drag-and-drop creation is always single-column (see erDiagramLayout.js
    // for why composite relationships are List-view-only) -- still needs
    // to be wrapped in arrays to match the data model.
    onAddForeignKey(pendingConnection.fromTable, {
      columns: [pendingConnection.fromColumn],
      refTable: pendingConnection.toTable,
      refColumns: [pendingConnection.toColumn],
      unique: pendingConnection.unique,
    });
    setPendingConnection(null);
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
                onRowRef={(col, el) => {
                  const key = `${name}::${col}`;
                  if (el) rowRefs.current.set(key, el);
                  else rowRefs.current.delete(key);
                }}
                onRowMouseDown={(col, e) => handleRowMouseDown(name, col, e)}
                dragTargetColumn={hoverTarget?.table === name ? hoverTarget.column : null}
              />
            );
          })}
        </div>
      ))}

      {positions && rowPositions && (
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
            // Anchor at the first column pair -- for a composite (multi-
            // column) relationship, drawing N parallel lines would clutter
            // the diagram for little benefit; the label still lists every
            // column so the full relationship is legible.
            const fromRow = rowPositions[`${edge.from}::${edge.columns[0]}`];
            const toRow = rowPositions[`${edge.to}::${edge.refColumns[0]}`];
            const fromCard = positions[edge.from];
            const toCard = positions[edge.to];
            if (!fromRow || !toRow || !fromCard || !toCard) return null;

            const { fromSide, toSide } = pickSides(fromCard, toCard);
            const fromAnchor = rowAnchor(fromRow, fromCard, fromSide);
            const toAnchor = rowAnchor(toRow, toCard, toSide);
            const d = bezierPath(fromAnchor, toAnchor, fromSide, toSide);
            const midX = (fromAnchor.x + toAnchor.x) / 2;
            const midY = (fromAnchor.y + toAnchor.y) / 2;

            return (
              <g key={i}>
                <path
                  d={d}
                  className={edge.synthetic ? "er-edge synthetic" : "er-edge"}
                  markerEnd="url(#er-arrow)"
                />
                {edge.synthetic && (
                  <path
                    d={d}
                    className="er-edge-hit"
                    onMouseEnter={() => setHoveredEdgeIndex(i)}
                    onMouseLeave={() => setHoveredEdgeIndex((cur) => (cur === i ? null : cur))}
                  />
                )}
                <text x={midX} y={midY} className="er-fk-label">
                  {edge.columns.join(", ")}
                </text>
                {edge.synthetic && hoveredEdgeIndex === i && (
                  <g
                    transform={`translate(${midX}, ${midY - 14})`}
                    className="er-edge-delete"
                    onClick={() => onRemoveForeignKey(edge.from, edge.fkIndex)}
                  >
                    <circle r="8" />
                    <text textAnchor="middle" dy="3">
                      ✕
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {selfEdges.map((edge, i) => {
            const cardPos = positions[edge.from];
            const fromRow = rowPositions[`${edge.from}::${edge.columns[0]}`];
            const toRow = rowPositions[`${edge.from}::${edge.refColumns[0]}`];
            if (!cardPos || !fromRow || !toRow) return null;

            const fromAnchor = { x: cardPos.x + cardPos.width, y: fromRow.y + fromRow.height / 2 };
            const toAnchor = { x: cardPos.x + cardPos.width, y: toRow.y + toRow.height / 2 };
            const bulge = 50;
            const d = `M ${fromAnchor.x} ${fromAnchor.y} C ${fromAnchor.x + bulge} ${fromAnchor.y}, ${toAnchor.x + bulge} ${toAnchor.y}, ${toAnchor.x} ${toAnchor.y}`;

            return (
              <g key={`self-${i}`}>
                <path
                  d={d}
                  className={edge.synthetic ? "er-edge synthetic" : "er-edge"}
                  markerEnd="url(#er-arrow)"
                />
                {edge.synthetic && (
                  <path
                    d={d}
                    className="er-edge-hit"
                    onMouseEnter={() => setHoveredEdgeIndex(`self-${i}`)}
                    onMouseLeave={() =>
                      setHoveredEdgeIndex((cur) => (cur === `self-${i}` ? null : cur))
                    }
                  />
                )}
                <text x={fromAnchor.x + bulge / 2} y={(fromAnchor.y + toAnchor.y) / 2} className="er-fk-label">
                  {edge.columns.join(", ")}
                </text>
                {edge.synthetic && hoveredEdgeIndex === `self-${i}` && (
                  <g
                    transform={`translate(${fromAnchor.x + bulge / 2}, ${(fromAnchor.y + toAnchor.y) / 2 - 14})`}
                    className="er-edge-delete"
                    onClick={() => onRemoveForeignKey(edge.from, edge.fkIndex)}
                  >
                    <circle r="8" />
                    <text textAnchor="middle" dy="3">
                      ✕
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {dragStart &&
            cursorPos &&
            (() => {
              const cardPos = positions[dragStart.table];
              const rowPos = rowPositions[`${dragStart.table}::${dragStart.column}`];
              if (!cardPos || !rowPos) return null;
              const cardCenter = cardPos.x + cardPos.width / 2;
              const side = cursorPos.x >= cardCenter ? "right" : "left";
              const anchor = rowAnchor(rowPos, cardPos, side);
              const bulge = 60;
              const c1x = anchor.x + (side === "right" ? bulge : -bulge);
              const d = `M ${anchor.x} ${anchor.y} C ${c1x} ${anchor.y}, ${cursorPos.x} ${cursorPos.y}, ${cursorPos.x} ${cursorPos.y}`;
              return <path d={d} className="er-edge synthetic dragging" />;
            })()}
        </svg>
      )}

      {pendingConnection && (
        <div
          className="er-connection-popup"
          style={{ left: pendingConnection.x, top: pendingConnection.y }}
        >
          <div className="hint">
            {pendingConnection.fromTable}.{pendingConnection.fromColumn} →{" "}
            {pendingConnection.toTable}.{pendingConnection.toColumn}
          </div>
          <span className="pill-toggle" style={{ marginTop: 6 }}>
            <button
              className={!pendingConnection.unique ? "active" : ""}
              onClick={() => setPendingConnection((p) => ({ ...p, unique: false }))}
            >
              one-to-many
            </button>
            <button
              className={pendingConnection.unique ? "active" : ""}
              onClick={() => setPendingConnection((p) => ({ ...p, unique: true }))}
            >
              one-to-one
            </button>
          </span>
          <div style={{ marginTop: 8 }}>
            <button className="btn" onClick={confirmConnection}>
              Add
            </button>
            <button
              className="btn secondary"
              style={{ marginLeft: 6 }}
              onClick={() => setPendingConnection(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

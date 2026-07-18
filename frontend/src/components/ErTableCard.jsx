import { forwardRef } from "react";

// A single table rendered as a card for the ER diagram -- same visual
// language as MappingCanvas.jsx's relational cards (.er-card/.er-card-title/
// .er-card-body/.er-row/etc.), but its own independent implementation so the
// diagram doesn't need to touch MappingCanvas.jsx at all. Forwards the ref
// so ErDiagram.jsx can measure its rendered position for drawing connector
// lines.
const ErTableCard = forwardRef(function ErTableCard(
  { table, onRowRef, onRowMouseDown, dragTargetColumn },
  ref
) {
  return (
    <div className="er-card diagram" ref={ref}>
      <div className="er-card-title">
        <span className="er-dot amber" /> {table.name}
      </div>
      <div className="er-card-body">
        {table.columns.map((c) => (
          <div
            className={`er-row${dragTargetColumn === c.name ? " drag-target" : ""}`}
            key={c.name}
            data-table={table.name}
            data-column={c.name}
            ref={(el) => onRowRef?.(c.name, el)}
            // Computed columns have no real source column, so they can
            // never be a sensible relationship endpoint -- not draggable,
            // same rule enforced in SchemaTree.jsx's dropdowns.
            onMouseDown={c.computed ? undefined : (e) => onRowMouseDown?.(c.name, e)}
            title={c.computed ? "Computed column -- can't be used in a relationship" : undefined}
            style={c.computed ? { opacity: 0.6, cursor: "default" } : undefined}
          >
            <span className={c.isPrimaryKey ? "er-col-pk" : "er-col-name"}>
              {c.isPrimaryKey ? "🔑 " : ""}
              {c.name}
            </span>
            <span className="er-col-type">{c.computed ? "computed" : c.dataType}</span>
          </div>
        ))}
      </div>
    </div>
  );
});

export default ErTableCard;

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
            onMouseDown={(e) => onRowMouseDown?.(c.name, e)}
          >
            <span className={c.isPrimaryKey ? "er-col-pk" : "er-col-name"}>
              {c.isPrimaryKey ? "🔑 " : ""}
              {c.name}
            </span>
            <span className="er-col-type">{c.dataType}</span>
          </div>
        ))}
      </div>
    </div>
  );
});

export default ErTableCard;

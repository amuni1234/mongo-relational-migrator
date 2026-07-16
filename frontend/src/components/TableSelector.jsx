import { useState } from "react";

/**
 * Lets the user pick a subset of the introspected tables to actually work
 * with downstream (mapping, Glue job generation, deployment). Useful the
 * moment a source has 100 tables and you only care about 5 of them --
 * everything after this step (suggest-mapping, the diagram, the generated
 * script) only ever sees the filtered set.
 */
export default function TableSelector({ schema, onContinue }) {
  const [selected, setSelected] = useState(() => new Set(schema.tables.map((t) => t.name)));
  const [filterText, setFilterText] = useState("");

  function toggle(name) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(schema.tables.map((t) => t.name)));
  }

  function selectNone() {
    setSelected(new Set());
  }

  const filteredTables = schema.tables.filter((t) =>
    t.name.toLowerCase().includes(filterText.toLowerCase())
  );

  return (
    <div className="panel">
      <h2>2. Choose tables</h2>
      <p className="hint">
        {schema.tables.length} table{schema.tables.length === 1 ? "" : "s"} were found.
        Pick the ones you actually want to migrate — handy when a source
        database has far more tables than you need for this job. Only the
        tables you select here are sent on to mapping and job generation.
      </p>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Filter tables by name…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="btn secondary" type="button" onClick={selectAll}>
          Select all
        </button>
        <button className="btn secondary" type="button" onClick={selectNone}>
          Select none
        </button>
      </div>

      <div style={{ maxHeight: 360, overflowY: "auto" }}>
        {filteredTables.map((table) => (
          <label
            key={table.name}
            className="table-chip"
            style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", marginBottom: 6 }}
          >
            <input
              type="checkbox"
              checked={selected.has(table.name)}
              onChange={() => toggle(table.name)}
            />
            <div>
              <strong>{table.name}</strong>{" "}
              <span style={{ color: "var(--muted)" }}>
                ({table.columns.length} column{table.columns.length === 1 ? "" : "s"}
                {table.foreignKeys.length > 0 ? `, ${table.foreignKeys.length} FK` : ""})
              </span>
            </div>
          </label>
        ))}
        {filteredTables.length === 0 && (
          <p className="hint">No tables match "{filterText}".</p>
        )}
      </div>

      <div className="status-line" style={{ margin: "14px 0" }}>
        {selected.size} of {schema.tables.length} table{schema.tables.length === 1 ? "" : "s"} selected
      </div>

      <button
        className="btn"
        disabled={selected.size === 0}
        onClick={() => onContinue(Array.from(selected))}
      >
        Continue to mapping →
      </button>
    </div>
  );
}
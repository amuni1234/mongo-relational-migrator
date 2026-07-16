export default function SchemaTree({ schema, onContinue }) {
  if (!schema) return null;

  return (
    <div className="panel">
      <h2>2. Source schema</h2>
      <p className="hint">
        {schema.tables.length} table{schema.tables.length === 1 ? "" : "s"} found.
        Foreign keys are what the mapping step below uses to suggest embed vs.
        reference.
      </p>

      {schema.tables.map((table) => (
        <div key={table.name} className="table-chip" style={{ marginBottom: 10 }}>
          <strong>{table.name}</strong>{" "}
          <span style={{ color: "var(--muted)" }}>
            ({table.primaryKey.join(", ") || "no PK"})
          </span>
          <div className="cols">
            {table.columns.map((c) => c.name).join(", ")}
          </div>
          {table.foreignKeys.length > 0 && (
            <div className="cols" style={{ color: "var(--sql-amber)" }}>
              FK: {table.foreignKeys
                .map((fk) => `${fk.column} → ${fk.refTable}.${fk.refColumn}`)
                .join("  |  ")}
            </div>
          )}
        </div>
      ))}

      <button className="btn" onClick={onContinue}>
        Continue to mapping →
      </button>
    </div>
  );
}

import { useState } from "react";
import ErDiagram from "./ErDiagram.jsx";

// Keep in sync with backend/src/bsonTypeMapper.js's BSON_TYPES.
const BSON_TYPES = ["string", "int", "long", "double", "decimal128", "bool", "date"];

export default function SchemaTree({
  schema,
  workingSchema,
  selectedTableNames,
  onToggleTable,
  onSelectAllTables,
  onDeselectAllTables,
  onAddForeignKey,
  onRemoveForeignKey,
  onChangeColumnBsonType,
  onContinue,
}) {
  // "list" is the interactive editor (BSON types, synthetic FKs); "diagram"
  // is a read-only visualization of the same schema.
  const [viewMode, setViewMode] = useState("list");
  // Which table's "+ Add relationship" picker is open, and its form state.
  const [addRelationshipOpenFor, setAddRelationshipOpenFor] = useState(null);
  const [formState, setFormState] = useState({});

  if (!schema) return null;

  // Only selected tables are valid relationship targets -- anything else
  // would just be silently dropped from workingSchema anyway.
  const selectableTables = schema.tables.filter((t) => selectedTableNames.has(t.name));

  function openAddRelationship(tableName) {
    const table = schema.tables.find((t) => t.name === tableName);
    const defaultRefTable = selectableTables.find((t) => t.name !== tableName) || table;
    setFormState({
      column: table.columns[0]?.name || "",
      refTable: defaultRefTable.name,
      refColumn: defaultRefTable.columns[0]?.name || "",
      unique: false,
    });
    setAddRelationshipOpenFor(tableName);
  }

  function isSelfReference(tableName) {
    return tableName === formState.refTable && formState.column === formState.refColumn;
  }

  function submitAddRelationship(tableName) {
    if (isSelfReference(tableName)) return;
    const { column, refTable, refColumn, unique } = formState;
    onAddForeignKey(tableName, { column, refTable, refColumn, unique });
    setAddRelationshipOpenFor(null);
  }

  return (
    <div className="panel">
      <h2>2. Source schema</h2>
      <p className="hint">
        {schema.tables.length} table{schema.tables.length === 1 ? "" : "s"} found.
        Foreign keys are what the mapping step below uses to suggest embed vs.
        reference. Each column shows a suggested target BSON type — change it
        if the guess is wrong. Use "+ Add relationship" to manually declare a
        relationship the source database doesn't enforce as a real foreign key.
      </p>

      <div className="er-table-selector">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="hint" style={{ margin: 0 }}>
            {selectedTableNames.size} of {schema.tables.length} tables selected for
            Mapping/the Glue job
          </span>
          <span>
            <button className="btn secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={onSelectAllTables}>
              Select all
            </button>{" "}
            <button className="btn secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={onDeselectAllTables}>
              Deselect all
            </button>
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          {schema.tables.map((t) => (
            <label key={t.name} className="er-table-chip">
              <input
                type="checkbox"
                checked={selectedTableNames.has(t.name)}
                onChange={() => onToggleTable(t.name)}
              />
              {t.name}
            </label>
          ))}
        </div>
      </div>

      <span className="pill-toggle" style={{ marginBottom: 14 }}>
        <button className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")}>
          List
        </button>
        <button
          className={viewMode === "diagram" ? "active" : ""}
          onClick={() => setViewMode("diagram")}
        >
          Diagram
        </button>
      </span>

      {viewMode === "diagram" && (
        <ErDiagram
          schema={workingSchema}
          onAddForeignKey={onAddForeignKey}
          onRemoveForeignKey={onRemoveForeignKey}
        />
      )}

      {viewMode === "list" &&
        schema.tables
          .filter((table) => selectedTableNames.has(table.name))
          .map((table) => (
        <div key={table.name} className="table-chip" style={{ marginBottom: 14 }}>
          <strong>{table.name}</strong>{" "}
          <span style={{ color: "var(--muted)" }}>
            ({table.primaryKey.join(", ") || "no PK"})
          </span>

          <div className="cols" style={{ marginTop: 6 }}>
            {table.columns.map((c) => (
              <div
                key={c.name}
                style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}
              >
                <span style={{ minWidth: 140 }}>
                  {c.isPrimaryKey ? "🔑 " : ""}
                  {c.name}
                </span>
                <span style={{ color: "var(--muted)", minWidth: 160 }}>{c.dataType}</span>
                <select
                  value={c.bsonType}
                  onChange={(e) => onChangeColumnBsonType(table.name, c.name, e.target.value)}
                  style={c.bsonTypeConfident ? undefined : { color: "var(--sql-amber)" }}
                  title={
                    c.bsonTypeConfident
                      ? "Confident type match"
                      : "Unrecognized source type -- guessed default, please confirm"
                  }
                >
                  {BSON_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {!c.bsonTypeConfident && <span className="er-muted">(guessed)</span>}
              </div>
            ))}
          </div>

          {table.foreignKeys.length > 0 && (
            <div className="cols" style={{ color: "var(--sql-amber)", marginTop: 6 }}>
              {table.foreignKeys.map((fk, i) => (
                <div key={`${fk.column}-${fk.refTable}-${i}`}>
                  FK: {fk.column} → {fk.refTable}.{fk.refColumn}
                  {fk.synthetic && (
                    <>
                      {" "}
                      <span className="er-muted">[synthetic]</span>
                      <button
                        className="er-unembed-btn"
                        title="Remove synthetic relationship"
                        onClick={() => onRemoveForeignKey(table.name, i)}
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 8 }}>
            <button
              className="btn secondary"
              style={{ padding: "4px 10px", fontSize: 12 }}
              onClick={() =>
                addRelationshipOpenFor === table.name
                  ? setAddRelationshipOpenFor(null)
                  : openAddRelationship(table.name)
              }
            >
              + Add relationship
            </button>
          </div>

          {addRelationshipOpenFor === table.name && (
            <div
              style={{
                marginTop: 8,
                padding: 10,
                border: "1px solid var(--border)",
                borderRadius: 6,
              }}
            >
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <label style={{ margin: 0 }}>
                  Column
                  <select
                    value={formState.column}
                    onChange={(e) => setFormState((f) => ({ ...f, column: e.target.value }))}
                  >
                    {table.columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span>→</span>
                <label style={{ margin: 0 }}>
                  Table
                  <select
                    value={formState.refTable}
                    onChange={(e) => {
                      const refTable = schema.tables.find((t) => t.name === e.target.value);
                      setFormState((f) => ({
                        ...f,
                        refTable: e.target.value,
                        refColumn: refTable?.columns[0]?.name || "",
                      }));
                    }}
                  >
                    {selectableTables.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ margin: 0 }}>
                  Column
                  <select
                    value={formState.refColumn}
                    onChange={(e) => setFormState((f) => ({ ...f, refColumn: e.target.value }))}
                  >
                    {(selectableTables.find((t) => t.name === formState.refTable)?.columns || []).map(
                      (c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      )
                    )}
                  </select>
                </label>
                <span className="pill-toggle">
                  <button
                    className={!formState.unique ? "active" : ""}
                    onClick={() => setFormState((f) => ({ ...f, unique: false }))}
                  >
                    one-to-many
                  </button>
                  <button
                    className={formState.unique ? "active" : ""}
                    onClick={() => setFormState((f) => ({ ...f, unique: true }))}
                  >
                    one-to-one
                  </button>
                </span>
              </div>

              {isSelfReference(table.name) && (
                <div className="hint" style={{ color: "var(--sql-amber)", marginTop: 6 }}>
                  A column can't reference itself — pick a different column or table.
                </div>
              )}

              <button
                className="btn"
                style={{ marginTop: 8 }}
                disabled={isSelfReference(table.name)}
                onClick={() => submitAddRelationship(table.name)}
              >
                Add
              </button>
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

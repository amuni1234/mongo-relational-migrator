import { useRef, useState } from "react";
import ErDiagram from "./ErDiagram.jsx";
import { api } from "../api";

// Keep in sync with backend/src/bsonTypeMapper.js's BSON_TYPES.
const BSON_TYPES = ["string", "int", "long", "double", "decimal128", "bool", "date"];
const NUMERIC_BSON_TYPES = new Set(["int", "long", "double", "decimal128"]);

// Structured computed-column operations -- each still just produces a plain
// expression string (same `computed: { expression }` data model as before),
// so this is a pure frontend convenience layer. "customize" falls back to
// the original free-form textarea for anything these don't cover.
const OPERATIONS = [
  { key: "add", label: "Add (a + b)", params: 2, numeric: true, build: (a, b) => `${a} + ${b}` },
  { key: "subtract", label: "Subtract (a - b)", params: 2, numeric: true, build: (a, b) => `${a} - ${b}` },
  { key: "multiply", label: "Multiply (a × b)", params: 2, numeric: true, build: (a, b) => `${a} * ${b}` },
  { key: "divide", label: "Divide (a ÷ b)", params: 2, numeric: true, build: (a, b) => `${a} / ${b}` },
  { key: "concat", label: "Concatenate (a || b)", params: 2, numeric: false, build: (a, b) => `${a} || ' ' || ${b}` },
  { key: "current_date", label: "Current date", params: 0, build: () => "CURRENT_DATE()" },
  { key: "current_timestamp", label: "Current timestamp", params: 0, build: () => "CURRENT_TIMESTAMP()" },
  { key: "customize", label: "Customize (write your own expression)", params: -1 },
];

// A field in a structured (params: 2) operation is either a real column
// (rendered as a bare identifier) or a user-typed constant -- rendered as a
// raw number for a numeric operation, or a quoted SQL string literal
// (single quotes doubled to escape any embedded ones) for concat.
function renderOperand(op, field) {
  if (field.mode === "constant") {
    if (op.numeric) return field.value;
    return `'${(field.value || "").replace(/'/g, "''")}'`;
  }
  return field.value; // a column name
}

// True once both operands of a params:2 operation have something usable --
// a picked column, or a non-empty typed constant. Gates canSubmit so an
// empty constant box doesn't silently fall through to a broken expression.
function fieldsComplete(form) {
  const filled = (f) => f && f.value != null && String(f.value).trim() !== "";
  return filled(form.fieldA) && filled(form.fieldB);
}

// The expression that will actually be used, whichever mode is active --
// structured operations derive it from the picked fields, "customize" uses
// whatever was typed directly.
function effectiveExpression(op, form) {
  if (op.params === 2) return op.build(renderOperand(op, form.fieldA), renderOperand(op, form.fieldB));
  if (op.params === 0) return op.build();
  return form.expression;
}

function defaultFieldsFor(op, realCols) {
  const candidates = op.numeric ? realCols.filter((c) => NUMERIC_BSON_TYPES.has(c.bsonType)) : realCols;
  return {
    fieldA: { mode: "column", value: candidates[0]?.name || "" },
    fieldB: { mode: "column", value: candidates[1]?.name || "" },
  };
}

// A computed column has no real source column, so it can never sensibly be
// a primary key, a foreign key endpoint, or a watermark column -- every
// picker/default in this file that offers "a column on this table" must
// exclude these.
function realColumnsOf(table) {
  return table.columns.filter((c) => !c.computed);
}

// SQL noise words the expression validator shouldn't flag as "unknown
// column" -- heuristic and intentionally short; this is "some validation",
// not a SQL parser. Case-insensitive.
const SQL_KEYWORD_ALLOWLIST = new Set([
  "null", "true", "false", "and", "or", "not", "case", "when", "then", "else", "end",
  "is", "in", "like", "as", "cast", "distinct", "between",
  "current_date", "current_timestamp", "current_user",
]);

// Best-effort, non-exhaustive check: flags an expression that's empty, or
// that references what looks like a column name not present (as a real,
// non-computed column) on this table. Real correctness can only be
// confirmed by actually running the generated script in Spark -- this just
// catches obvious typos before generation.
function validateComputedExpression(expression, table) {
  if (!expression.trim()) return { error: "Expression can't be empty." };
  const realNames = new Set(realColumnsOf(table).map((c) => c.name.toLowerCase()));
  const tokens = expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  const unknown = [];
  for (const token of tokens) {
    const idx = expression.indexOf(token);
    const followedByParen = expression.slice(idx + token.length).trimStart().startsWith("(");
    if (followedByParen) continue; // function call, not a column reference
    if (SQL_KEYWORD_ALLOWLIST.has(token.toLowerCase())) continue;
    if (realNames.has(token.toLowerCase())) continue;
    if (!unknown.includes(token)) unknown.push(token);
  }
  if (unknown.length > 0) {
    return {
      warning: `Doesn't look like a column on this table (may be a false positive -- this check isn't a full SQL parser): ${unknown.join(", ")}`,
    };
  }
  return {};
}

export default function SchemaTree({
  schema,
  workingSchema,
  selectedTableNames,
  dbType,
  connection,
  onToggleTable,
  onSelectAllTables,
  onDeselectAllTables,
  onAddForeignKey,
  onRemoveForeignKey,
  onChangeColumnBsonType,
  onSetWatermarkColumn,
  onAddComputedColumn,
  onRemoveComputedColumn,
  onContinue,
}) {
  // "list" is the interactive editor (BSON types, synthetic FKs); "diagram"
  // is a read-only visualization of the same schema.
  const [viewMode, setViewMode] = useState("list");
  // Which table's "+ Add relationship" picker is open, and its form state.
  const [addRelationshipOpenFor, setAddRelationshipOpenFor] = useState(null);
  const [formState, setFormState] = useState({});
  // Which table's "+ Add computed column" picker is open, and its form state.
  const [addComputedOpenFor, setAddComputedOpenFor] = useState(null);
  const [computedForm, setComputedForm] = useState({
    name: "",
    bsonType: "string",
    operation: "add",
    fieldA: { mode: "column", value: "" },
    fieldB: { mode: "column", value: "" },
    expression: "",
  });
  // Result of the real dry-run validation for the *current* computedForm --
  // null means "not checked yet for these inputs" (reset on every edit so a
  // stale result never gets attributed to different inputs).
  const [validation, setValidation] = useState(null);
  const expressionRef = useRef(null);

  if (!schema) return null;

  // Only selected tables are valid relationship targets -- anything else
  // would just be silently dropped from workingSchema anyway.
  const selectableTables = schema.tables.filter((t) => selectedTableNames.has(t.name));

  function openAddRelationship(tableName) {
    const table = schema.tables.find((t) => t.name === tableName);
    const defaultRefTable = selectableTables.find((t) => t.name !== tableName) || table;
    setFormState({
      // One row per column pair -- most relationships are single-column,
      // but "+ Add column pair" below lets a composite (multi-column) key
      // be built up one pair at a time.
      pairs: [{ column: realColumnsOf(table)[0]?.name || "", refColumn: realColumnsOf(defaultRefTable)[0]?.name || "" }],
      refTable: defaultRefTable.name,
      unique: false,
    });
    setAddRelationshipOpenFor(tableName);
  }

  function addColumnPair(tableName) {
    const table = schema.tables.find((t) => t.name === tableName);
    const refTable = schema.tables.find((t) => t.name === formState.refTable);
    setFormState((f) => ({
      ...f,
      pairs: [...f.pairs, { column: realColumnsOf(table)[0]?.name || "", refColumn: realColumnsOf(refTable || table)[0]?.name || "" }],
    }));
  }

  function openAddComputedColumn(tableName) {
    const table = schema.tables.find((t) => t.name === tableName);
    const firstOp = OPERATIONS[0];
    setComputedForm({
      name: "",
      bsonType: "string",
      operation: firstOp.key,
      expression: "",
      ...defaultFieldsFor(firstOp, realColumnsOf(table)),
    });
    setValidation(null);
    setAddComputedOpenFor(tableName);
  }

  // Any edit to the form invalidates whatever validation result was showing
  // -- it was for a different expression, and re-showing it would attribute
  // a stale verdict to the new inputs.
  function updateComputedForm(patch) {
    setComputedForm((f) => ({ ...f, ...patch }));
    setValidation(null);
  }

  function changeOperation(tableName, operationKey) {
    const table = schema.tables.find((t) => t.name === tableName);
    const op = OPERATIONS.find((o) => o.key === operationKey);
    updateComputedForm({ operation: operationKey, expression: "", ...defaultFieldsFor(op, realColumnsOf(table)) });
  }

  // Inserts `text` at the textarea's current cursor position (falling back
  // to appending at the end if the textarea hasn't been focused yet), so a
  // quick-insert helper composes into whatever the user has already typed
  // instead of always landing at the end. Customize mode only.
  function insertIntoExpression(text) {
    const el = expressionRef.current;
    const current = computedForm.expression;
    if (!el || el.selectionStart == null) {
      updateComputedForm({ expression: current + text });
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = current.slice(0, start) + text + current.slice(end);
    updateComputedForm({ expression: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  }

  function commitAddComputedColumn(tableName, expression) {
    const name = computedForm.name.trim();
    onAddComputedColumn(tableName, {
      name,
      dataType: null,
      nullable: true,
      isPrimaryKey: false,
      bsonType: computedForm.bsonType,
      bsonTypeConfident: true,
      computed: { expression },
    });
    setAddComputedOpenFor(null);
    setValidation(null);
  }

  // Real dry-run: spins up an actual (throwaway) Spark job that reads one
  // real row from the table via JDBC and evaluates `expression` against it
  // -- see backend/src/validateComputedExpression.js. This is a strong
  // nudge, not a hard gate: on failure the form offers an explicit
  // "add anyway" / "add without validating" override rather than blocking.
  async function handleValidateAndAdd(tableName, expression) {
    setValidation({ status: "checking" });
    try {
      const result = await api.validateComputedExpression({
        dbType,
        connection,
        table: tableName,
        expression,
        bsonType: computedForm.bsonType,
      });
      if (result.valid) {
        commitAddComputedColumn(tableName, expression);
      } else {
        setValidation({ status: "invalid", message: result.error });
      }
    } catch (err) {
      setValidation({ status: "infra_error", message: err.message });
    }
  }

  function removeColumnPair(index) {
    setFormState((f) => ({ ...f, pairs: f.pairs.filter((_, i) => i !== index) }));
  }

  function updatePair(index, field, value) {
    setFormState((f) => ({
      ...f,
      pairs: f.pairs.map((p, i) => (i === index ? { ...p, [field]: value } : p)),
    }));
  }

  function isSelfReference(tableName) {
    return tableName === formState.refTable && formState.pairs.some((p) => p.column === p.refColumn);
  }

  function submitAddRelationship(tableName) {
    if (isSelfReference(tableName)) return;
    const { pairs, refTable, unique } = formState;
    onAddForeignKey(tableName, {
      columns: pairs.map((p) => p.column),
      refTable,
      refColumns: pairs.map((p) => p.refColumn),
      unique,
    });
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

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <label style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>
              Watermark column (optional)
            </label>
            <select
              value={table.watermarkColumn || ""}
              onChange={(e) => onSetWatermarkColumn(table.name, e.target.value)}
              title="A last-modified timestamp column -- when set, Incremental/SCD2 narrow reads to rows changed since the last run instead of reading everything"
            >
              <option value="">none (always full read)</option>
              {realColumnsOf(table).map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="cols" style={{ marginTop: 6 }}>
            {table.columns.map((c, i) => (
              <div
                key={c.name}
                style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}
              >
                <span style={{ minWidth: 140 }}>
                  {c.isPrimaryKey ? "🔑 " : ""}
                  {c.name}
                </span>
                <span style={{ color: "var(--muted)", minWidth: 160 }}>
                  {c.computed ? "computed" : c.dataType}
                </span>
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
                {c.computed && (
                  <>
                    <span className="er-muted" title={c.computed.expression}>
                      [computed: {c.computed.expression}]
                    </span>
                    <button
                      className="er-unembed-btn"
                      title="Remove computed column"
                      onClick={() => onRemoveComputedColumn(table.name, i)}
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>

          {table.foreignKeys.length > 0 && (
            <div className="cols" style={{ color: "var(--sql-amber)", marginTop: 6 }}>
              {table.foreignKeys.map((fk, i) => (
                <div key={`${fk.columns.join(",")}-${fk.refTable}-${i}`}>
                  FK: {fk.columns.join(", ")} → {fk.refTable}.({fk.refColumns.join(", ")})
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
              <label style={{ margin: 0 }}>
                Table
                <select
                  value={formState.refTable}
                  onChange={(e) => {
                    const newRefTable = schema.tables.find((t) => t.name === e.target.value);
                    setFormState((f) => ({
                      ...f,
                      refTable: e.target.value,
                      // Old refColumn picks belonged to a different table --
                      // reset every pair to the new table's first column.
                      pairs: f.pairs.map((p) => ({
                        ...p,
                        refColumn: (newRefTable && realColumnsOf(newRefTable)[0]?.name) || "",
                      })),
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

              {formState.pairs.map((pair, i) => (
                <div
                  key={i}
                  style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}
                >
                  <label style={{ margin: 0 }}>
                    Column
                    <select value={pair.column} onChange={(e) => updatePair(i, "column", e.target.value)}>
                      {realColumnsOf(table).map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span>→</span>
                  <label style={{ margin: 0 }}>
                    Column
                    <select
                      value={pair.refColumn}
                      onChange={(e) => updatePair(i, "refColumn", e.target.value)}
                    >
                      {(() => {
                        const refTable = selectableTables.find((t) => t.name === formState.refTable);
                        return refTable ? realColumnsOf(refTable) : [];
                      })().map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {formState.pairs.length > 1 && (
                    <button
                      className="er-unembed-btn"
                      title="Remove this column pair"
                      onClick={() => removeColumnPair(i)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}

              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  className="btn secondary"
                  style={{ padding: "4px 10px", fontSize: 12 }}
                  onClick={() => addColumnPair(table.name)}
                >
                  + Add column pair
                </button>
                <span className="hint" style={{ margin: 0 }}>
                  (only needed for a composite/multi-column key)
                </span>
              </div>

              <div style={{ marginTop: 6 }}>
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

          <div style={{ marginTop: 8 }}>
            <button
              className="btn secondary"
              style={{ padding: "4px 10px", fontSize: 12 }}
              onClick={() =>
                addComputedOpenFor === table.name
                  ? setAddComputedOpenFor(null)
                  : openAddComputedColumn(table.name)
              }
            >
              + Add computed column
            </button>
          </div>

          {addComputedOpenFor === table.name &&
            (() => {
              const nameTrimmed = computedForm.name.trim();
              const nameCollision =
                !!nameTrimmed && table.columns.some((c) => c.name.toLowerCase() === nameTrimmed.toLowerCase());
              const currentOp = OPERATIONS.find((o) => o.key === computedForm.operation);
              const realCols = realColumnsOf(table);
              const fieldCandidates = currentOp.numeric
                ? realCols.filter((c) => NUMERIC_BSON_TYPES.has(c.bsonType))
                : realCols;
              const expression = effectiveExpression(currentOp, computedForm);
              const isCustomize = currentOp.key === "customize";
              const { error, warning } = isCustomize
                ? validateComputedExpression(expression, table)
                : {};
              const fieldsOk = currentOp.params === 2 ? fieldsComplete(computedForm) : true;
              const canSubmit = !!nameTrimmed && !nameCollision && fieldsOk && !!expression.trim() && !error;

              // One "Field A"/"Field B" picker -- a Column/Constant toggle
              // plus either a column <select> or a typed-value <input>,
              // shared between both fields to avoid duplicating the markup.
              function renderField(label, fieldKey) {
                const field = computedForm[fieldKey];
                const setField = (patch) => updateComputedForm({ [fieldKey]: { ...field, ...patch } });
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>{label}</span>
                      <span className="pill-toggle">
                        <button
                          className={field.mode === "column" ? "active" : ""}
                          onClick={() => setField({ mode: "column", value: fieldCandidates[0]?.name || "" })}
                        >
                          Column
                        </button>
                        <button
                          className={field.mode === "constant" ? "active" : ""}
                          onClick={() => setField({ mode: "constant", value: "" })}
                        >
                          Constant
                        </button>
                      </span>
                    </div>
                    {field.mode === "column" ? (
                      <select value={field.value} onChange={(e) => setField({ value: e.target.value })}>
                        {fieldCandidates.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={currentOp.numeric ? "number" : "text"}
                        value={field.value}
                        onChange={(e) => setField({ value: e.target.value })}
                        placeholder={currentOp.numeric ? "e.g. 5" : "e.g. Inc."}
                      />
                    )}
                  </div>
                );
              }

              return (
                <div
                  style={{
                    marginTop: 8,
                    padding: 10,
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                  }}
                >
                  <p className="hint" style={{ margin: "0 0 8px 0" }}>
                    Not read from the source table -- its value is computed at
                    runtime from a Spark SQL expression, referencing this
                    table's other (real) columns.
                  </p>

                  <label style={{ margin: 0 }}>
                    Column name
                    <input
                      type="text"
                      value={computedForm.name}
                      onChange={(e) => updateComputedForm({ name: e.target.value })}
                      placeholder="e.g. full_name"
                    />
                  </label>
                  {nameCollision && (
                    <div className="hint" style={{ color: "var(--sql-amber)", marginTop: 4 }}>
                      A column with that name already exists on this table.
                    </div>
                  )}

                  <label style={{ margin: "8px 0 0 0", display: "block" }}>
                    Output type
                    <select
                      value={computedForm.bsonType}
                      onChange={(e) => updateComputedForm({ bsonType: e.target.value })}
                    >
                      {BSON_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={{ margin: "8px 0 0 0", display: "block" }}>
                    Operation
                    <select
                      value={computedForm.operation}
                      onChange={(e) => changeOperation(table.name, e.target.value)}
                    >
                      {OPERATIONS.map((op) => (
                        <option key={op.key} value={op.key}>
                          {op.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {currentOp.params === 2 && (
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start", marginTop: 6 }}>
                      {renderField("Field A", "fieldA")}
                      {renderField("Field B", "fieldB")}
                    </div>
                  )}

                  {!isCustomize && (
                    <div className="hint" style={{ marginTop: 6, fontFamily: "monospace" }}>
                      Preview: {expression || "(pick fields)"}
                    </div>
                  )}

                  {isCustomize && (
                    <>
                      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <select
                          value=""
                          onChange={(e) => {
                            if (e.target.value) insertIntoExpression(e.target.value);
                            e.target.value = "";
                          }}
                          title="Insert a column reference at the cursor"
                        >
                          <option value="">Insert column…</option>
                          {realCols.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <button
                          className="btn secondary"
                          style={{ padding: "4px 10px", fontSize: 12 }}
                          onClick={() =>
                            insertIntoExpression(
                              realCols.length >= 2 ? `${realCols[0].name} + ${realCols[1].name}` : "a + b"
                            )
                          }
                        >
                          + template: add
                        </button>
                        <button
                          className="btn secondary"
                          style={{ padding: "4px 10px", fontSize: 12 }}
                          onClick={() =>
                            insertIntoExpression(
                              realCols.length >= 2 ? `${realCols[0].name} || ' ' || ${realCols[1].name}` : "a || ' ' || b"
                            )
                          }
                        >
                          + template: concat
                        </button>
                        <button
                          className="btn secondary"
                          style={{ padding: "4px 10px", fontSize: 12 }}
                          onClick={() => insertIntoExpression("CURRENT_DATE()")}
                        >
                          + template: current date
                        </button>
                        <button
                          className="btn secondary"
                          style={{ padding: "4px 10px", fontSize: 12 }}
                          onClick={() => insertIntoExpression("CURRENT_TIMESTAMP()")}
                        >
                          + template: current timestamp
                        </button>
                      </div>

                      <label style={{ margin: "8px 0 0 0", display: "block" }}>
                        Expression (Spark SQL)
                        <textarea
                          ref={expressionRef}
                          rows={3}
                          style={{ width: "100%", fontFamily: "monospace" }}
                          value={computedForm.expression}
                          onChange={(e) => updateComputedForm({ expression: e.target.value })}
                          placeholder="e.g. first_name || ' ' || last_name"
                        />
                      </label>
                      {warning && (
                        <div className="hint" style={{ color: "var(--sql-amber)", marginTop: 4 }}>
                          {warning}
                        </div>
                      )}
                      {error && (
                        <div className="hint" style={{ color: "var(--sql-amber)", marginTop: 4 }}>
                          {error}
                        </div>
                      )}
                    </>
                  )}

                  {(!validation || validation.status === "checking") && (
                    <button
                      className="btn"
                      style={{ marginTop: 8 }}
                      disabled={!canSubmit || validation?.status === "checking"}
                      onClick={() => handleValidateAndAdd(table.name, expression)}
                    >
                      {validation?.status === "checking" ? "Validating… (up to ~30s)" : "Validate & add"}
                    </button>
                  )}

                  {validation?.status === "invalid" && (
                    <>
                      <div className="hint" style={{ color: "var(--sql-amber)", marginTop: 8 }}>
                        Spark couldn't evaluate this against a real row: {validation.message}
                      </div>
                      <button
                        className="btn"
                        style={{ marginTop: 4 }}
                        onClick={() => commitAddComputedColumn(table.name, expression)}
                      >
                        Add anyway
                      </button>
                    </>
                  )}

                  {validation?.status === "infra_error" && (
                    <>
                      <div className="hint" style={{ color: "var(--sql-amber)", marginTop: 8 }}>
                        Couldn't validate (Docker or the database wasn't reachable): {validation.message}
                      </div>
                      <button
                        className="btn"
                        style={{ marginTop: 4 }}
                        onClick={() => commitAddComputedColumn(table.name, expression)}
                      >
                        Add without validating
                      </button>
                    </>
                  )}
                </div>
              );
            })()}
        </div>
      ))}

      <button className="btn" onClick={onContinue}>
        Continue to mapping →
      </button>
    </div>
  );
}

import { useMemo, useState } from "react";
import { api } from "./api";
import ConnectionForm from "./components/ConnectionForm.jsx";
import SchemaTree from "./components/SchemaTree.jsx";
import MappingCanvas from "./components/MappingCanvas.jsx";
import GlueJobPreview from "./components/GlueJobPreview.jsx";
import TestLoadPanel from "./components/TestLoadPanel.jsx";

const STEPS = [
  { key: "connect", label: "Connect" },
  { key: "schema", label: "Schema" },
  { key: "mapping", label: "Mapping" },
  { key: "glue", label: "Glue job" },
  { key: "test", label: "Test load" },
];

export default function App() {
  const [step, setStep] = useState("connect");
  const [dbType, setDbType] = useState("postgres");
  const [connection, setConnection] = useState(null);
  const [schema, setSchema] = useState(null);
  // Which introspected tables actually carry into Mapping/the Glue job --
  // defaults to "everything" the moment a schema is set, so behavior is
  // unchanged unless the user deliberately deselects something.
  const [selectedTableNames, setSelectedTableNames] = useState(new Set());
  const [mapping, setMapping] = useState(null);
  const [script, setScript] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  async function handleIntrospect(type, conn) {
    setError(null);
    setLoading(true);
    setDbType(type);
    setConnection(conn);
    try {
      const result = await api.introspect(type, conn);
      // TODO: this silently discards any synthetic FKs / BSON type overrides
      // the user already added to the previous `schema` -- worth a confirm
      // dialog before overwriting once that becomes a common workflow.
      setSchema(result);
      setSelectedTableNames(new Set(result.tables.map((t) => t.name)));
      setStep("schema");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function addSyntheticForeignKey(childTableName, fk) {
    setSchema((prev) => ({
      ...prev,
      tables: prev.tables.map((t) =>
        t.name === childTableName
          ? { ...t, foreignKeys: [...t.foreignKeys, { ...fk, synthetic: true }] }
          : t
      ),
    }));
  }

  function removeSyntheticForeignKey(childTableName, index) {
    setSchema((prev) => ({
      ...prev,
      tables: prev.tables.map((t) =>
        t.name === childTableName
          ? { ...t, foreignKeys: t.foreignKeys.filter((_, i) => i !== index) }
          : t
      ),
    }));
  }

  function setColumnBsonType(tableName, columnName, bsonType) {
    setSchema((prev) => ({
      ...prev,
      tables: prev.tables.map((t) =>
        t.name === tableName
          ? {
              ...t,
              columns: t.columns.map((c) =>
                c.name === columnName ? { ...c, bsonType } : c
              ),
            }
          : t
      ),
    }));
  }

  // `null` means "no watermark, always full read for this table" -- the
  // default, so nothing changes unless a user deliberately opts in.
  function setTableWatermarkColumn(tableName, columnName) {
    setSchema((prev) => ({
      ...prev,
      tables: prev.tables.map((t) =>
        t.name === tableName ? { ...t, watermarkColumn: columnName || null } : t
      ),
    }));
  }

  function toggleTableSelection(tableName) {
    setSelectedTableNames((prev) => {
      const next = new Set(prev);
      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);
      return next;
    });
  }

  function selectAllTables() {
    setSelectedTableNames(new Set(schema.tables.map((t) => t.name)));
  }

  function deselectAllTables() {
    setSelectedTableNames(new Set());
  }

  // The schema actually passed to Mapping/the Glue job -- only selected
  // tables, with each kept table's foreignKeys filtered to drop any FK
  // pointing at a table that isn't also selected (avoids dangling
  // references reaching MappingCanvas/glueJobGenerator.js, neither of
  // which guards against a refTable that doesn't exist in the array).
  const workingSchema = useMemo(() => {
    if (!schema) return null;
    return {
      tables: schema.tables
        .filter((t) => selectedTableNames.has(t.name))
        .map((t) => ({
          ...t,
          foreignKeys: t.foreignKeys.filter((fk) => selectedTableNames.has(fk.refTable)),
        })),
    };
  }, [schema, selectedTableNames]);

  async function handleGenerateGlueJob({ jdbc, mongo, loadMode }) {
    setError(null);
    setLoading(true);
    try {
      const result = await api.generateGlueJob({ jdbc, mongo, schema: workingSchema, mapping, loadMode });
      setScript(result.script);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function canVisit(key) {
    const idx = STEPS.findIndex((s) => s.key === key);
    if (idx <= stepIndex) return true;
    if (key === "schema") return !!schema;
    if (key === "mapping") return !!schema;
    if (key === "glue") return !!schema;
    if (key === "test") return !!schema;
    return false;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-title">
          <span className="amber">Relational</span> → <span className="teal">MongoDB</span> Migrator
        </h1>
      </header>
      <p className="app-subtitle">
        Introspect a source schema, design the embed/reference mapping, generate a runnable AWS Glue job, and test-load a sample into MongoDB.
      </p>

      <nav className="stepper">
        {STEPS.map((s, i) => (
          <button
            key={s.key}
            className={`step-tab ${step === s.key ? "active" : ""}`}
            disabled={!canVisit(s.key)}
            onClick={() => canVisit(s.key) && setStep(s.key)}
          >
            <span className="n">{String(i + 1).padStart(2, "0")}</span>
            {s.label}
          </button>
        ))}
      </nav>

      {error && <div className="error-banner">{error}</div>}

      {step === "connect" && (
        <ConnectionForm onIntrospect={handleIntrospect} loading={loading} />
      )}

      {step === "schema" && (
        <SchemaTree
          schema={schema}
          workingSchema={workingSchema}
          selectedTableNames={selectedTableNames}
          onToggleTable={toggleTableSelection}
          onSelectAllTables={selectAllTables}
          onDeselectAllTables={deselectAllTables}
          onAddForeignKey={addSyntheticForeignKey}
          onRemoveForeignKey={removeSyntheticForeignKey}
          onChangeColumnBsonType={setColumnBsonType}
          onSetWatermarkColumn={setTableWatermarkColumn}
          onContinue={() => setStep("mapping")}
        />
      )}

      {step === "mapping" && (
        <MappingCanvas
          schema={workingSchema}
          onChange={setMapping}
          onContinue={() => setStep("glue")}
        />
      )}

      {step === "glue" && (
        <>
          <GlueJobPreview
            dbType={dbType}
            connection={connection}
            onGenerate={handleGenerateGlueJob}
            script={script}
            loading={loading}
            error={error}
          />
          {script && (
            <div style={{ textAlign: "right" }}>
              <button className="btn secondary" onClick={() => setStep("test")}>
                Continue to test load →
              </button>
            </div>
          )}
        </>
      )}

      {step === "test" && (
        <TestLoadPanel collectionName={mapping?.collections?.[0]?.collectionName} />
      )}
    </div>
  );
}

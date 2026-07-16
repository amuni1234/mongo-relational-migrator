import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import ConnectionForm from "./components/ConnectionForm.jsx";
import SchemaTree from "./components/SchemaTree.jsx";
import TableSelector from "./components/TableSelector.jsx";
import MappingCanvas from "./components/MappingCanvas.jsx";
import GlueJobPreview from "./components/GlueJobPreview.jsx";
import DeployPanel from "./components/DeployPanel.jsx";
import TestLoadPanel from "./components/TestLoadPanel.jsx";

const STEPS = [
  { key: "connect", label: "Connect" },
  { key: "schema", label: "Schema" },
  { key: "tables", label: "Tables" },
  { key: "mapping", label: "Mapping" },
  { key: "glue", label: "Glue job" },
  { key: "deploy", label: "Deploy" },
  { key: "test", label: "Test load" },
];

export default function App() {
  const [step, setStep] = useState("connect");
  const [dbType, setDbType] = useState("postgres");
  const [connection, setConnection] = useState(null);
  const [schema, setSchema] = useState(null);
  // Which tables (by name) the user chose to actually work with -- lets a
  // 100-table source be scoped down instead of forcing everything through
  // the pipeline. null means "not chosen yet" (defaults to all tables).
  const [selectedTableNames, setSelectedTableNames] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [script, setScript] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Backend-suggested starting mapping (from POST /api/suggest-mapping),
  // used to seed the MappingCanvas diagram so the diagram reflects the same
  // embed/reference heuristics the backend actually uses — rather than the
  // diagram reimplementing its own separate guess client-side.
  const [suggestedMapping, setSuggestedMapping] = useState(null);
  const [suggestedMappingLoading, setSuggestedMappingLoading] = useState(false);
  const [suggestedMappingError, setSuggestedMappingError] = useState(null);

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  // The schema scoped down to just the tables the user picked in the Tables
  // step. Everything downstream (suggested mapping, the diagram, the
  // generated script) only ever sees this, not the full introspected schema.
  const filteredSchema = useMemo(() => {
    if (!schema) return null;
    if (!selectedTableNames) return schema;
    const keep = new Set(selectedTableNames);
    return { tables: schema.tables.filter((t) => keep.has(t.name)) };
  }, [schema, selectedTableNames]);

  // Fetch the backend's suggested mapping as soon as we have a (filtered)
  // schema and are heading into (or already on) the mapping step, so the
  // diagram has something to seed itself from instead of guessing locally.
  useEffect(() => {
    if (!filteredSchema) return;
    if (step !== "mapping") return;
    if (suggestedMapping || suggestedMappingLoading) return;

    let cancelled = false;
    setSuggestedMappingLoading(true);
    setSuggestedMappingError(null);
    api
      .suggestMapping(filteredSchema)
      .then((result) => {
        if (!cancelled) setSuggestedMapping(result);
      })
      .catch((err) => {
        if (!cancelled) setSuggestedMappingError(err.message);
      })
      .finally(() => {
        if (!cancelled) setSuggestedMappingLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredSchema, step]);

  // If the user reconnects / re-introspects / changes their table
  // selection, drop any stale suggestion so the next visit to the mapping
  // step re-fetches for the new (filtered) schema.
  useEffect(() => {
    setSuggestedMapping(null);
    setSuggestedMappingError(null);
  }, [filteredSchema]);

  async function handleIntrospect(type, conn) {
    setError(null);
    setLoading(true);
    setDbType(type);
    setConnection(conn);
    try {
      const result = await api.introspect(type, conn);
      setSchema(result);
      setSelectedTableNames(null); // reset -- new schema, choose tables again
      setStep("schema");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerateGlueJob({ jdbc, mongo, loadStrategy }) {
    setError(null);
    setLoading(true);
    try {
      const result = await api.generateGlueJob({
        jdbc,
        mongo,
        schema: filteredSchema,
        mapping,
        loadStrategy,
      });
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
    if (key === "tables") return !!schema;
    if (key === "mapping") return !!filteredSchema;
    if (key === "glue") return !!filteredSchema;
    if (key === "deploy") return !!script;
    if (key === "test") return !!filteredSchema;
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
        Introspect a source schema, choose which tables to migrate, design the embed/reference mapping, generate a runnable full or incremental job, and deploy or test-load it.
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
        <SchemaTree schema={schema} onContinue={() => setStep("tables")} />
      )}

      {step === "tables" && schema && (
        <TableSelector
          schema={schema}
          onContinue={(names) => {
            setSelectedTableNames(names);
            setStep("mapping");
          }}
        />
      )}

      {step === "mapping" && filteredSchema && (
        <MappingCanvas
          schema={filteredSchema}
          suggestedMapping={suggestedMapping}
          suggestedMappingLoading={suggestedMappingLoading}
          suggestedMappingError={suggestedMappingError}
          onRetrySuggestedMapping={() => {
            setSuggestedMappingError(null);
            setSuggestedMapping(null);
          }}
          onChange={setMapping}
          onContinue={() => setStep("glue")}
        />
      )}

      {step === "glue" && (
        <>
          <GlueJobPreview
            dbType={dbType}
            connection={connection}
            schema={filteredSchema}
            onGenerate={handleGenerateGlueJob}
            script={script}
            loading={loading}
            error={error}
          />
          {script && (
            <div style={{ textAlign: "right", display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button className="btn secondary" onClick={() => setStep("deploy")}>
                Continue to deploy →
              </button>
              <button className="btn secondary" onClick={() => setStep("test")}>
                Continue to test load →
              </button>
            </div>
          )}
        </>
      )}

      {step === "deploy" && <DeployPanel script={script} />}

      {step === "test" && (
        <TestLoadPanel collectionName={mapping?.collections?.[0]?.collectionName} />
      )}
    </div>
  );
}

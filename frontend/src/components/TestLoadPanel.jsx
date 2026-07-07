import { useEffect, useState } from "react";
import { api } from "../api";

const DEFAULT_SAMPLE = JSON.stringify(
  [
    { customer_id: 1, name: "Sample Customer", addresses: [{ city: "Chennai" }] },
  ],
  null,
  2
);

export default function TestLoadPanel({ collectionName }) {
  const [uri, setUri] = useState("mongodb://localhost:27017");
  const [database, setDatabase] = useState("migrator_test");
  const [collection, setCollection] = useState(collectionName || "customers");
  const [documentsText, setDocumentsText] = useState(DEFAULT_SAMPLE);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Prefill from the backend's own .env (MONGODB_URI / MONGODB_DB) so a
  // real connection string doesn't need to be retyped into the browser
  // each time. Only overrides the field if it's still at its hardcoded
  // default -- won't clobber something the user already typed in.
  useEffect(() => {
    api
      .mongoDefaults()
      .then(({ uri: defaultUri, database: defaultDatabase }) => {
        if (defaultUri) {
          setUri((current) => (current === "mongodb://localhost:27017" ? defaultUri : current));
        }
        if (defaultDatabase) {
          setDatabase((current) => (current === "migrator_test" ? defaultDatabase : current));
        }
      })
      .catch(() => {}); // no .env defaults configured -- keep the hardcoded fallback
  }, []);

  async function runTestLoad() {
    setError(null);
    setResult(null);
    let documents;
    try {
      documents = JSON.parse(documentsText);
    } catch {
      setError("Documents must be valid JSON (an array of objects).");
      return;
    }
    setLoading(true);
    try {
      const res = await api.testLoad({ uri, database, collection, documents });
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel">
      <h2>5. Test-load a sample into MongoDB</h2>
      <p className="hint">
        Sanity-check the document shape against a real MongoDB before running
        the full Glue job. This writes to a scratch collection you name below
        — it does not touch your relational source.
      </p>

      <div className="grid-2">
        <div>
          <label>MongoDB URI</label>
          <input type="text" value={uri} onChange={(e) => setUri(e.target.value)} />
        </div>
        <div>
          <label>Database</label>
          <input type="text" value={database} onChange={(e) => setDatabase(e.target.value)} />
        </div>
      </div>
      <label>Collection</label>
      <input type="text" value={collection} onChange={(e) => setCollection(e.target.value)} />

      <label>Sample documents (JSON array)</label>
      <textarea
        rows={8}
        value={documentsText}
        onChange={(e) => setDocumentsText(e.target.value)}
      />

      <button className="btn" onClick={runTestLoad} disabled={loading}>
        {loading ? "Loading…" : "Run test load"}
      </button>

      {error && <div className="error-banner" style={{ marginTop: 16 }}>{error}</div>}

      {result && (
        <>
          <div className={`status-line ok`} style={{ marginTop: 14 }}>
            Inserted {result.insertedCount} document(s). Collection now has{" "}
            {result.totalInCollection} total.
          </div>
          {result.sample.map((doc) => (
            <pre key={doc._id} className="sample-doc">
              {JSON.stringify(doc, null, 2)}
            </pre>
          ))}
        </>
      )}
    </div>
  );
}

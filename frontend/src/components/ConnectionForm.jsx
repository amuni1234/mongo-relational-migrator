import { useState } from "react";

export default function ConnectionForm({ onIntrospect, loading }) {
  const [dbType, setDbType] = useState("postgres");
  const [form, setForm] = useState({
    host: "localhost",
    port: "5432",
    database: "",
    user: "",
    password: "",
  });

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function handleDbTypeChange(value) {
    setDbType(value);
    update("port", value === "postgres" ? "5432" : "3306");
  }

  function submit(e) {
    e.preventDefault();
    const connection = {
      host: form.host,
      port: Number(form.port),
      database: form.database,
      user: form.user,
      password: form.password,
    };
    onIntrospect(dbType, connection);
  }

  return (
    <div className="panel">
      <h2>1. Connect to the relational source</h2>
      <p className="hint">
        Credentials are sent directly to your backend for a one-time schema
        read — nothing is stored.
      </p>
      <form onSubmit={submit}>
        <label>Database type</label>
        <select value={dbType} onChange={(e) => handleDbTypeChange(e.target.value)}>
          <option value="postgres">PostgreSQL</option>
          <option value="mysql">MySQL</option>
        </select>

        <div className="grid-2">
          <div>
            <label>Host</label>
            <input
              type="text"
              value={form.host}
              onChange={(e) => update("host", e.target.value)}
            />
          </div>
          <div>
            <label>Port</label>
            <input
              type="number"
              value={form.port}
              onChange={(e) => update("port", e.target.value)}
            />
          </div>
        </div>

        <label>Database name</label>
        <input
          type="text"
          value={form.database}
          onChange={(e) => update("database", e.target.value)}
          placeholder="e.g. banking_core"
          required
        />

        <div className="grid-2">
          <div>
            <label>User</label>
            <input
              type="text"
              value={form.user}
              onChange={(e) => update("user", e.target.value)}
              required
            />
          </div>
          <div>
            <label>Password</label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => update("password", e.target.value)}
            />
          </div>
        </div>

        <button className="btn amber" type="submit" disabled={loading}>
          {loading ? "Reading schema…" : "Introspect schema"}
        </button>
      </form>
    </div>
  );
}

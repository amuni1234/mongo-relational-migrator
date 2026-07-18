const BASE = "/api";

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request to ${path} failed`);
  return data;
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request to ${path} failed`);
  return data;
}

export const api = {
  introspect: (dbType, connection) => post("/introspect", { dbType, connection }),
  suggestMapping: (schema) => post("/suggest-mapping", { schema }),
  generateGlueJob: (payload) => post("/generate-glue-job", payload),
  testLoad: (payload) => post("/test-load", payload),
  mongoDefaults: () => get("/mongo-defaults"),
  // Resolves { valid: true } or { valid: false, error } for an expression-
  // level outcome (both are HTTP 200); throws (via post()'s !res.ok check)
  // only when validation itself couldn't run at all (Docker/DB unreachable).
  validateComputedExpression: (payload) => post("/validate-computed-expression", payload),
  // Resolves { engine, success, log } once the local Docker run finishes
  // (can take up to a few minutes, especially the EMR engine's first-ever
  // Maven package resolution); throws only if the run infrastructure itself
  // failed (Docker missing/unreachable), not if the job ran and failed.
  runLocal: (payload) => post("/run-local", payload),
};

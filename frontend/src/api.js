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
};

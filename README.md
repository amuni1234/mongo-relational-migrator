# Relational → MongoDB Migrator

A small, self-hosted tool (Node/Express backend + React frontend) that mirrors
the core workflow of **MongoDB Relational Migrator**:

1. **Connect** to a relational source (PostgreSQL or MySQL) and introspect its
   schema (tables, columns, primary keys, foreign keys).
2. **Review the schema** the tool found.
3. **Design the document mapping** — for every foreign-key relationship,
   choose *embed* (nest the child inside the parent document) or *reference*
   (keep it as its own collection). The tool suggests a sensible starting
   point automatically: small single-parent children (like `addresses`) are
   suggested for embedding; fast-growing or independently-related tables
   (like `transactions`, `orders`, `logs`) default to reference.
4. **Generate an AWS Glue job** — a ready-to-upload PySpark script (Glue 4.0)
   that reads each table via JDBC, joins/nests the embedded children with
   `collect_list(struct(...))`, and writes each resulting DataFrame into
   MongoDB using the MongoDB Spark Connector. JDBC passwords are resolved
   from AWS Secrets Manager at runtime — never hardcoded into the script.
5. **Test-load a sample** — write a handful of example documents into a real
   MongoDB collection to sanity-check the shape before running the full Glue
   job against production-scale data.

## Project layout

```
mongo-relational-migrator/
├── backend/            Express API: introspection, mapping suggestions,
│                        Glue script generation, Mongo test-load
│   ├── server.js
│   └── src/
│       ├── introspect.js            (Postgres + MySQL schema reader)
│       ├── schemaMapper.js          (embed/reference auto-suggestion)
│       ├── generators/
│       │   └── glueJobGenerator.js  (emits the PySpark Glue script)
│       ├── mongoLoader.js           (sample-document test load)
│       └── routes/api.js
└── frontend/           React (Vite) UI — a 5-step wizard
    └── src/
        ├── App.jsx
        └── components/
            ├── ConnectionForm.jsx
            ├── SchemaTree.jsx
            ├── MappingEditor.jsx
            ├── GlueJobPreview.jsx
            └── TestLoadPanel.jsx
```

## Running it locally

**Backend**
```bash
cd backend
cp .env.example .env   # adjust PORT / MONGODB_URI if needed
npm install
npm run dev             # http://localhost:4000
```

**Frontend**
```bash
cd frontend
npm install
npm run dev              # http://localhost:5173 (proxies /api to :4000)
```

Open `http://localhost:5173` and walk through the five steps.

## Using the generated Glue job

The downloaded `.py` script assumes:
- **Glue version 4.0+** (Spark 3.x)
- The **MongoDB Spark Connector** added as a job dependency (attach via a
  Glue custom connector, or add its Maven coordinates under
  "Dependent JARs path" in the job's Advanced properties)
- A **Secrets Manager** secret holding `{"password": "..."}` for the JDBC
  user, named whatever you entered as "Secrets Manager secret name" in the
  UI — the script's IAM role needs `secretsmanager:GetSecretValue` on it
- Standard JDBC driver JARs (Postgres/MySQL) available to the job, same as
  any other Glue JDBC connection

Upload the script as the job's script location, set the `--JOB_NAME` job
parameter (Glue does this automatically), and run.

## Notes on the embed/reference heuristic

The auto-suggestion is intentionally simple and fully editable in the UI:
- A child table with **exactly one foreign key** (i.e. it only relates to one
  parent) is suggested for **embedding**, unless its name matches a
  "high-growth" pattern (`transaction`, `order`, `log`, `event`,
  `interaction`, `audit`, `history`) — those default to **reference** so a
  single customer document can't grow past MongoDB's 16MB limit.
- A child table with **more than one foreign key** (e.g. a many-to-many join
  table) always defaults to **reference**.

You can override any of these per-relationship in the Mapping step, and flip
cardinality between "one" and "many" (which changes whether the generated
script embeds a single nested object or an array).

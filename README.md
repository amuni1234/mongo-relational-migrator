# Relational → MongoDB Migrator

A small, self-hosted tool (Node/Express backend + React frontend) that mirrors
the core workflow of **MongoDB Relational Migrator**, but generates a
Spark-based execution job (AWS Glue today; EMR/Dataproc planned) instead of
running the migration as a single desktop process — so it can scale past
what Relational Migrator's single-job engine handles.

1. **Connect** to a relational source (PostgreSQL or MySQL) and introspect its
   schema (tables, columns, primary keys, foreign keys, and single-column
   unique constraints).
2. **Review the schema** the tool found — including a suggested target BSON
   type per column (editable), and the option to manually declare a
   **synthetic foreign key** for relationships the source database doesn't
   enforce as a real constraint. See
   [Synthetic foreign keys and BSON type mapping](#synthetic-foreign-keys-and-bson-type-mapping).
3. **Design the document mapping** — for every foreign-key relationship,
   choose *embed* (nest the child inside the parent document) or *reference*
   (keep it as its own collection). The tool suggests a sensible starting
   point automatically: small single-parent children (like `addresses`) are
   suggested for embedding; fast-growing or independently-related tables
   (like `transactions`, `orders`, `logs`) default to reference. It also
   infers **cardinality** (`one` vs `many`) per embed from unique
   constraints, shown as an editable one/many toggle — see
   [Embed/reference and cardinality heuristics](#embedreference-and-cardinality-heuristics).
4. **Generate an AWS Glue job** — a ready-to-upload PySpark script (Glue 4.0)
   that reads each table via JDBC, joins/nests the embedded children with
   `collect_list(struct(...))` (or a single `struct(...)` for one-to-one
   embeds), and writes each resulting DataFrame into MongoDB using the
   MongoDB Spark Connector. JDBC passwords are resolved from AWS Secrets
   Manager at runtime — never hardcoded into the script.
5. **Test-load a sample** — write a handful of hand-authored example
   documents into a real MongoDB collection (local or Atlas) to sanity-check
   the shape before running the full Glue job against production-scale data.
   This does **not** read from the relational source — see
   [Testing the generated Glue job for real](#testing-the-generated-glue-job-for-real-no-aws-required)
   for that.

## Project layout

```
mongo-relational-migrator/
├── backend/            Express API: introspection, mapping suggestions,
│                        Glue script generation, Mongo test-load
│   ├── server.js
│   └── src/
│       ├── introspect.js            (Postgres + MySQL schema reader)
│       ├── schemaMapper.js          (embed/reference + cardinality auto-suggestion)
│       ├── bsonTypeMapper.js        (source SQL type -> BSON type -> Spark cast type)
│       ├── generators/
│       │   └── glueJobGenerator.js  (emits the PySpark Glue script)
│       ├── mongoLoader.js           (sample-document test load)
│       └── routes/api.js            (introspect, suggest-mapping,
│                                      generate-glue-job, test-load,
│                                      mongo-defaults)
├── frontend/            React (Vite) UI — a 5-step wizard
│   └── src/
│       ├── App.jsx
│       ├── api.js
│       └── components/
│           ├── ConnectionForm.jsx
│           ├── SchemaTree.jsx        (List / Diagram toggle -- see below)
│           ├── ErDiagram.jsx         (read-only ER diagram, SVG-based)
│           ├── ErTableCard.jsx       (single-table card, shared by ErDiagram)
│           ├── MappingCanvas.jsx     (drag-and-drop embed/reference editor)
│           ├── GlueJobPreview.jsx
│           └── TestLoadPanel.jsx
│       └── lib/
│           └── erDiagramLayout.js   (pure tiered-layout logic for ErDiagram)
└── scripts/             Local (no-AWS) Glue job test harness
    ├── test-local-glue.sh
    └── make_local_test_variant.py
```

## Running it locally

**Backend**
```bash
cd backend
cp .env.example .env   # adjust PORT / MONGODB_URI if needed
npm install
npm run dev             # http://localhost:4000
```

### API docs / testing endpoints in isolation

With the backend running, open **http://localhost:4000/api-docs** for an
interactive Swagger UI covering all 5 endpoints (`introspect`,
`suggest-mapping`, `generate-glue-job`, `test-load`, `mongo-defaults`), each
with a realistic example payload pre-filled. Useful for testing one stage of
the pipeline directly — e.g. hitting `/api/suggest-mapping` on its own with a
hand-edited schema to check the cardinality inference, without going through
the introspect step or the wizard UI at all. The spec lives at
`backend/openapi.json`.

**Frontend**
```bash
cd frontend
npm install
npm run dev              # http://localhost:5173 (proxies /api to :4000)
```

Open `http://localhost:5173` and walk through the five steps. Note there is
no persistence anywhere in this tool yet — `schema`/`mapping` only live in
the browser tab's React state (`App.jsx`); refreshing the page loses your
progress and you'll need to re-introspect and redo the mapping.

### Trying it against a disposable test database

If you don't have a Postgres/MySQL source handy, spin up a throwaway one in
Docker and seed it with a schema that exercises both embed cardinalities:

```bash
docker run --rm -d --name migrator-test-pg -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:16

docker exec -i migrator-test-pg psql -U postgres <<'EOF'
CREATE TABLE customers (id serial PRIMARY KEY, name text NOT NULL, email text);
CREATE TABLE customer_profiles (id serial PRIMARY KEY, customer_id int UNIQUE REFERENCES customers(id), bio text, loyalty_tier text);
CREATE TABLE addresses (id serial PRIMARY KEY, customer_id int REFERENCES customers(id), street text, city text);
CREATE TABLE orders (id serial PRIMARY KEY, customer_id int REFERENCES customers(id), total numeric, placed_at timestamp DEFAULT now());

INSERT INTO customers (name, email) VALUES ('Ada Lovelace', 'ada@example.com'), ('Alan Turing', 'alan@example.com');
INSERT INTO customer_profiles (customer_id, bio, loyalty_tier) VALUES (1, 'Mathematician', 'gold'), (2, 'Computer scientist', 'silver');
INSERT INTO addresses (customer_id, street, city) VALUES (1, '12 Analytical Engine Way', 'London'), (1, '1 Second Home St', 'London'), (2, '99 Bletchley Rd', 'Milton Keynes');
INSERT INTO orders (customer_id, total) VALUES (1, 42.50), (1, 17.00), (2, 99.99);
EOF
```

Connect to it in the wizard with host `localhost`, port `5433`, database
`postgres`, user `postgres`, password `test`. `customer_profiles` has a
`UNIQUE` constraint on `customer_id` (one-to-one), while `addresses` and
`orders` don't (one-to-many) — this is what lets you see both cardinality
branches in the generated script.

For a Mongo target, either run one locally:
```bash
docker run --rm -d --name migrator-test-mongo -p 27017:27017 mongo:7
```
or use a free [MongoDB Atlas](https://cloud.mongodb.com) M0 cluster —
**Connect → Drivers → Node.js**, copy the `mongodb+srv://...` connection
string, and use it as the Mongo URI in the wizard. Note Atlas M0 (free tier)
does **not** support AWS PrivateLink/VPC peering, so a real Glue job reaching
an M0 cluster needs a NAT Gateway (or equivalent public egress) if run inside
a VPC — see cost notes below.

## Embed/reference and cardinality heuristics

The auto-suggestion is intentionally simple and fully editable by rearranging
cards in the Mapping step's canvas:

- A child table with **exactly one foreign key** (i.e. it only relates to one
  parent) is suggested for **embedding**, unless its name matches a
  "high-growth" pattern (`transaction`, `order`, `log`, `event`,
  `interaction`, `audit`, `history`) — those default to **reference** so a
  single parent document can't grow past MongoDB's 16MB limit.
- A child table with **more than one foreign key** (e.g. a many-to-many join
  table) always defaults to **reference**.
- **Cardinality** (`one` vs `many`) for each embed is inferred from the
  source schema: if the child's foreign-key column is covered by a
  single-column `UNIQUE` or `PRIMARY KEY` constraint, the relationship is
  one-to-one and the generated script embeds a single nested `struct(...)`;
  otherwise it's one-to-many and the script uses
  `collect_list(struct(...))` to embed an array. This is shown as a
  one/many pill toggle next to each embedded block in the Mapping canvas —
  defaulting to the inferred value, labeled `(auto)`, and switching to
  `(manual)` once you click the other option. The override only lives in
  that step's local state (see [Known gaps](#known-gaps) for what that
  means if you navigate away and back).

## Synthetic foreign keys and BSON type mapping

Modeled directly on how MongoDB's real Relational Migrator handles two cases
our schema-inference can't: relationships the source database doesn't
enforce as a real constraint, and source SQL types that don't map cleanly to
a MongoDB type without a human deciding.

- **Synthetic foreign keys** — in the Schema step, "+ Add relationship" on
  any table lets you declare a relationship (child column → parent
  table/column) that has no real `FOREIGN KEY` constraint in the source
  database. Since there's no constraint to detect uniqueness from, you pick
  "one-to-one" or "one-to-many" directly — that choice becomes the `unique`
  flag, feeding into the *same* cardinality inference described above
  unchanged. Synthetic relationships are marked `[synthetic]` and
  individually removable; real (introspected) foreign keys are not.
- **Target BSON type per column** — each column shows a suggested BSON type
  (`string`/`int`/`long`/`double`/`decimal128`/`bool`/`date`), inferred from
  the source SQL type by `backend/src/bsonTypeMapper.js`, and editable via a
  dropdown. Columns whose source type wasn't recognized (e.g. `jsonb`,
  `uuid`, `enum`) fall back to `string` and are visually flagged as a guess
  rather than a confident match. The generated Glue script casts every
  column to its BSON type's Spark equivalent immediately after each
  `read_table(...)` call — including a `date` → Spark `timestamp` (not
  `date`) mapping, since BSON's `Date` is a full instant and Spark's
  `DateType` would otherwise silently drop the time component.

## ER diagram

The Schema step has a **List / Diagram** toggle. List is the interactive
editor described above (BSON types, synthetic FKs) and stays the default;
Diagram is a read-only visualization of the same schema, built from scratch
with plain SVG (no graph/diagram library — this project has none, and none
was added for this).

- Tables are laid out in tiers by a simple topological pass over the
  foreign-key graph (`frontend/src/lib/erDiagramLayout.js`): tables with no
  outgoing FK sit in tier 0, each subsequent tier holds tables whose FKs all
  point into earlier tiers, and any leftover tables (a genuine multi-table FK
  cycle) get dumped into one final tier so layout always terminates. Tables
  within a tier are then reordered by the average position of their FK
  targets in the tier above, to reduce line crossings.
- Connector lines are cubic Beziers spread across each card's edge width (so
  several edges into/out of the same table don't all overlap at one point),
  drawn **dashed** for synthetic FKs and solid for real ones — mirroring the
  `[synthetic]` badge already used in List view. Self-referencing FKs (a
  table pointing at itself) render as a small loop instead of a line.
- Card positions are measured from the actual rendered DOM
  (`getBoundingClientRect`-equivalent via `offsetLeft`/`offsetTop`) rather
  than computed from a height formula, since card height varies with column
  count — this keeps the diagram correct without having to hand-derive
  sizing constants that would drift out of sync with `styles.css`.
- No pan/zoom — the diagram container just scrolls. Fine for the tens of
  tables this is meant for; not designed for hundreds.

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
- Writes use `mode("overwrite")` — there is no incremental/idempotent write
  strategy yet, so re-runs replace the target collection's contents rather
  than upserting

Upload the script as the job's script location, set the `--JOB_NAME` job
parameter (Glue does this automatically), and run.

### Real AWS run — architecture and rough cost

Running this for real requires the source database to be network-reachable
from AWS (Glue cannot reach a database on your laptop), which typically means
an RDS instance. Rough on-demand costs for a short test (us-east-1, likely
$0 if your account is still Free-Tier eligible):

| Resource | Rate | Short test |
|---|---|---|
| RDS `db.t3.micro` | $0.03/hr + $0.115/GB-mo storage | ~$0.10–0.30 |
| Glue job, 2×G.1X workers (practical minimum for a batch job — G.025X is streaming-only) | $0.44/DPU-hr | ~$0.10–0.15 per run |
| NAT Gateway (only if the Mongo target is on the public internet, e.g. Atlas) | $0.045/hr + $0.045/GB | ~$0.10–0.30, but **~$33/mo if left running** |
| Secrets Manager | $0.40/mo per secret | ~$0.01–0.02 prorated |

The NAT Gateway is the one to watch — it's only needed because Atlas lives
outside your VPC; Atlas M0 doesn't support PrivateLink to remove that need
(only M10+ does). Pointing the AWS-side test at **Amazon DocumentDB**
instead (MongoDB-wire-compatible, lives in the same VPC as RDS/Glue) avoids
the NAT Gateway entirely, at the cost of not testing against your actual
Atlas cluster. Delete the RDS instance and NAT Gateway promptly after
testing — they're the two resources that quietly rack up cost if forgotten.

## Testing the generated Glue job for real (no AWS required)

`scripts/test-local-glue.sh` regenerates the schema/mapping/Glue script from
the running backend and executes the **actual generated PySpark script**
using AWS's own official local development image,
`amazon/aws-glue-libs:glue_libs_4.0.0_image_01` — the same Spark 3.3 runtime,
with the Postgres JDBC driver and MongoDB Spark Connector already bundled,
that real Glue 4.0 jobs run on. This validates the real transformation logic
(the embed/reference joins and the one/many cardinality branching) with real
Spark execution, at zero AWS cost — it just can't validate anything that's
specific to Glue's *managed infrastructure* (job bookmarking, IAM, Secrets
Manager).

```bash
# defaults assume the disposable Postgres/Mongo containers from above
./scripts/test-local-glue.sh

# override any of these to point elsewhere, e.g. at Atlas:
MONGO_URI="mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/?appName=Cluster0" \
  ./scripts/test-local-glue.sh
```

What it does:
1. Calls `/api/introspect`, `/api/suggest-mapping`, `/api/generate-glue-job`
   against the running backend, writing each intermediate result to
   `.local-test/` (gitignored).
2. Runs `scripts/make_local_test_variant.py` to produce a **local-test-only**
   copy of the generated script that reads the JDBC password from an
   environment variable instead of calling AWS Secrets Manager (there's no
   AWS account involved when running purely in a local container) — the real
   generator output (`glueJobGenerator.js`) is untouched by this.
3. Runs that copy via `spark-submit` inside the Glue container, with
   `host.docker.internal` used so the container can reach ports published on
   your machine (e.g. the disposable Postgres/Mongo containers above).
4. Leaves the full Spark log at `.local-test/spark_run.log`.

## Known gaps

- Glue-only — no EMR/Dataproc generator yet
- Writes use `mode("overwrite")` — no incremental/idempotent write strategy
- Postgres introspection hardcodes the `public` schema
- No check-constraint discovery
- No persistence — schema/mapping only live in browser memory for the
  session. Two consequences worth knowing:
  - The Mapping canvas fully unmounts when you leave that step, so
    navigating back to the (now-editable) Schema step and forward again
    silently resets any embed/rename/cardinality-override choices you made.
  - Re-running introspect (going back to Connect) unconditionally replaces
    the schema, silently discarding any synthetic foreign keys or BSON type
    overrides you'd added — no confirmation prompt yet.
- No SSL/TLS option in the Connect step — most managed databases (RDS,
  Atlas, etc.) require or prefer it
- If a child table ends up with two foreign keys to the same parent (easy to
  create now that synthetic FKs exist), only the first one found is used —
  silently, with no warning
- Picking mismatched BSON types for what's logically the same join key on
  either side of an embed (e.g. parent `id` → `long`, child FK → `int`)
  isn't flagged — Spark will likely numeric-promote rather than fail, but
  it's an unchecked correctness risk

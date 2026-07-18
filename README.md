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

Optionally, add a composite (multi-column) key pair too, to exercise that
support specifically:
```sql
CREATE TABLE order_items (order_id int NOT NULL, line_no int NOT NULL, product_name text, quantity int, PRIMARY KEY (order_id, line_no));
CREATE TABLE shipments (order_id int NOT NULL, line_no int NOT NULL, shipped_at timestamp, CONSTRAINT fk_shipment_item FOREIGN KEY (order_id, line_no) REFERENCES order_items(order_id, line_no));

INSERT INTO order_items (order_id, line_no, product_name, quantity) VALUES (1, 1, 'Widget', 5), (1, 2, 'Gadget', 3), (2, 1, 'Gizmo', 1);
INSERT INTO shipments (order_id, line_no, shipped_at) VALUES (1, 1, '2026-01-01 10:00:00'), (1, 2, '2026-01-02 11:00:00'), (2, 1, '2026-01-03 12:00:00');
```
Order 1's two line items share the same `order_id` but have different
`line_no`s and distinct shipments — a good check that the embed join is
matching on the *full* composite key, not just `order_id`.

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

## Computed / derived columns

In the Schema step, "+ Add computed column" on any table lets you add a
column that isn't read from the source database at all — its value is
computed at runtime from a Spark SQL expression, referencing that table's
other real columns by name. An **Operation** dropdown covers the common
cases without any typing: **Add/Subtract/Multiply/Divide** (pick two numeric
fields), **Concatenate** (pick two fields of any type), and **Current
date**/**Current timestamp** (no fields needed). Picking **"Customize"**
falls back to a free-form expression textarea — with the same column-picker
and one-click templates as before — for anything the built-in operations
don't cover. Whichever mode is used, it always ends up as the same one
expression string passed to pyspark's `expr()`; the operation picker is
purely a frontend convenience for building that string without typing it
by hand (and without any risk of misspelling a column name, since the
built-in operations only ever offer real columns from a dropdown).

Before a column is actually added, click **"Validate & add"** — this runs a
real, throwaway Spark job (the same local Docker Glue image
`scripts/test-local-glue.sh` uses) that reads one real row from your actual
table via JDBC and evaluates the exact expression against it, live. This
takes several seconds (a Spark cold start) and requires Docker plus your
database to be reachable from wherever the backend runs, but catches things
the instant heuristic check can't — a genuine type mismatch, a Spark
function that doesn't exist, etc. It's a strong nudge, not a hard gate: on
failure (or if validation itself couldn't run — Docker/DB unreachable) the
form shows the real error and offers an explicit **"Add anyway"** /
**"Add without validating"** override, so you're never blocked from adding
the column.

A few rules and limits worth knowing:

- **A computed column can only reference other real (non-computed) columns
  already on the same table** — not another computed column, not a column
  from a different table. This isn't an arbitrary restriction: `expr()`
  inside the generated script's `.select(...)` resolves against the raw,
  just-read DataFrame, the same as every other expression in that same
  select call, so a reference to anything else simply wouldn't exist yet.
  The Schema step's validator enforces this before you ever get to
  generation.
- **Validation is heuristic, not a SQL parser** — it flags an expression
  that's empty or that references what looks like an unrecognized column
  name, as a non-blocking warning (it can false-positive on SQL functions
  it doesn't know about). A column **name** colliding with an existing
  column on that table *is* a hard block, since that isn't a heuristic risk
  — it's a guaranteed `AnalysisException: Reference 'x' is ambiguous` at
  actual Glue runtime. Real correctness of the expression itself can only be
  confirmed by actually running the generated script in Spark.
- **Computed columns can't be a primary key, foreign key, or watermark
  column** — every column picker in the Schema step and the ER diagram
  excludes them, since none of those make sense for a value that isn't
  actually stored in the source database.
- **SCD2 + a non-deterministic expression, on a root-level computed column,
  is handled** — SCD2 hashes every column to detect changed rows; a
  computed column with a volatile expression like `CURRENT_TIMESTAMP()`
  would otherwise hash differently on every run regardless of whether the
  real underlying row changed, permanently defeating SCD2's "unchanged rows
  are dropped" behavior. Root-level computed columns are excluded from that
  hash (their value is still written to the document as normal, just not
  used for change detection). **This exclusion does not extend to a
  computed column added on an embedded child table** — avoid volatile
  expressions there when using SCD2, or every run will look like a change
  for that parent document.

## Composite (multi-column) key support

Every foreign key — real or synthetic — is represented as `{ columns: [...],
refTable, refColumns: [...] }`, always arrays, in corresponding order
(`columns[i]` on the child maps to `refColumns[i]` on the parent). Length 1
for an ordinary single-column FK; length N for a composite one.

- **Introspection.** Postgres FK detection uses `pg_constraint`'s
  `conkey`/`confkey` arrays (`unnest(...) WITH ORDINALITY`, joined on
  matching ordinal position) rather than the `information_schema`
  3-way join — the latter produces a **cartesian product** for a
  composite FK (a 2-column FK constraint yields 2×2=4 rows instead of 2
  correctly-paired ones, since nothing correlates which source column
  pairs with which referenced column). Confirmed empirically before fixing
  it: a real 2-column FK on a test table produced exactly this 4-row
  mismatch under the old query. MySQL's `key_column_usage` doesn't have
  this problem — it already pairs columns correctly per row.
- **Uniqueness / cardinality** for a composite FK is checked against the
  FK's *entire* column set (as a set, any order) matching some
  UNIQUE/PRIMARY KEY constraint on the child table — not any single column
  in isolation.
- **Embed joins** in the generated Glue script AND every column-pair
  position together (`(root[pk0] == child[fk0]) & (root[pk1] ==
  child[fk1])`, and so on) — fixed after finding that the join previously
  only used the *first* column of a composite root primary key, which
  would silently attach child rows to the wrong parent whenever two
  parent rows shared the same first-key-column value. Verified with a
  concrete case (two `order_items` rows sharing the same `order_id` but
  different `line_no`, each with its own distinct `shipments` row) — each
  line item correctly got only its own shipment, not both.
- **Authoring**: the Schema step's "+ Add relationship" form supports
  building up a composite relationship one column-pair at a time ("+ Add
  column pair"). The **ER diagram's drag-and-drop stays single-column
  only** for *creating* a new relationship — it still correctly *displays*
  an existing composite relationship as one edge (anchored at the first
  column pair, labeled with every column name), it just can't build a
  multi-column one via drag-and-drop.

## ER diagram

The Schema step has a **List / Diagram** toggle. List is the interactive
editor described above (BSON types, synthetic FKs) and stays the default;
Diagram is a visualization of the same schema, built from scratch with plain
SVG (no graph/diagram library — this project has none, and none was added
for this) — and is itself editable, not just read-only.

- Tables are laid out in tiers by a simple topological pass over the
  foreign-key graph (`frontend/src/lib/erDiagramLayout.js`): tables with no
  outgoing FK sit in tier 0, each subsequent tier holds tables whose FKs all
  point into earlier tiers, and any leftover tables (a genuine multi-table FK
  cycle) get dumped into one final tier so layout always terminates. Tables
  within a tier are then reordered by the average position of their FK
  targets in the tier above, to reduce line crossings.
- Connector lines anchor at the *actual FK/PK column rows* they connect
  (not generic card edges), drawn **dashed** for synthetic FKs and solid for
  real ones — mirroring the `[synthetic]` badge already used in List view.
  Self-referencing FKs (a table pointing at itself) render as a small loop.
- **Create a relationship** by dragging from one column row to another —
  drop it, confirm one-to-one vs. one-to-many (can't be inferred from the
  drag alone), and it's added as a synthetic FK, identical to using List
  view's "+ Add relationship" form. Dropping outside any column row cancels
  cleanly.
- **Delete a relationship** by hovering a dashed (synthetic) line and
  clicking the ✕ that appears. Real (non-synthetic) lines aren't
  interactive — same rule List view already enforces, only synthetic FKs
  are removable.
- Changing an existing relationship's cardinality is List-view-only for
  now — the diagram doesn't have an equivalent control yet.
- Card and row positions are measured from the actual rendered DOM
  (`offsetLeft`/`offsetTop`, combined per-row-relative-to-its-own-card)
  rather than computed from a height formula, since card height varies with
  column count — this keeps the diagram correct without having to
  hand-derive sizing constants that would drift out of sync with
  `styles.css`.
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
- **Load mode**, chosen in the wizard's Glue job step:
  - **Full** (default) — `mode("overwrite")`, which drops/truncates each
    target collection before writing. Safe for a first load; destructive on
    re-runs.
  - **Incremental** — `mode("append")` + the MongoDB Spark Connector's
    `idFieldList` option set to each collection's primary key, so re-runs
    upsert (update-if-matched, insert-if-not) instead of wiping the
    collection first. `operationType` is explicitly set to `"update"`
    (`upsertDocument` stays at its default, `true`) rather than the
    connector's own default of `"replace"` — `update` performs a partial
    `$set` of just the columns in the mapped schema, so any field on an
    existing document that isn't part of this collection's mapping (hand-
    added directly in Mongo, or written by a separate pipeline) survives a
    re-run instead of being wiped by a full-document replace (confirmed by
    testing both ways). **Two things incremental does NOT do**: it doesn't
    delete target documents whose source row was
    deleted (a row removed from Postgres/MySQL leaves its Mongo document
    behind), and — unless a watermark column is configured (see
    "Watermark-based incremental extract" below) — it doesn't reduce how
    much is read from the source; every run reads the full table via JDBC.
  - **Incremental (SCD2)** — preserves history instead of replacing in
    place. Each incoming row gets a content hash (covering every real
    column); rows whose hash matches the collection's current
    (`isCurrent: true`) version are left untouched (zero writes). A
    changed or brand-new row gets a fresh document inserted
    (`isCurrent: true`, `validFrom: <now>`, `validTo: null`), while its
    prior version — if one existed — is closed out via a **partial
    update** (`isCurrent: false`, `validTo: <now>`), not a replace, so the
    old document's content is preserved untouched as history. Matching for
    that partial update is done on a generated `_versionId`
    (`uuid()`), not MongoDB's own `_id` — the Spark Connector reads an
    `_id` ObjectId back as a bare hex string with no type marker, and
    writing that same string back does not get reinterpreted as the
    original ObjectId, so matching on `_id` directly would silently insert
    a brand-new malformed document instead of updating the existing one
    (confirmed by testing both ways). Versioning applies to the **whole
    joined document** — a change to an embedded child row (e.g. one
    `addresses` entry) with no change to the parent row still produces a
    new version of the entire customer document, since the content hash
    covers the fully-joined result. One embed-specific correctness detail:
    `collect_list`'s array order isn't stable across runs, which would make
    the hash spuriously differ even with identical underlying data — SCD2
    mode wraps many-cardinality embeds in `array_sort(...)` (with the
    child's own primary key placed first in the struct, so plain
    single-argument `array_sort` — the only form Spark 3.3/Glue 4.0
    supports — sorts by it) to keep hashes stable. Like Incremental, SCD2
    reads the full source table every run unless a watermark column is
    configured; the efficiency gain from SCD2 itself is fewer/no-op MongoDB
    writes, which is a separate concern from how much gets read.

Upload the script as the job's script location, set the `--JOB_NAME` job
parameter (Glue does this automatically), and run.

### Watermark-based incremental extract

An optional, orthogonal add-on to Incremental/SCD2 (ignored outright in
Full mode, which always drops/rebuilds every collection from scratch —
narrowing its read would just silently lose unchanged rows). Set a
**watermark column** — a last-modified timestamp — per table via the new
dropdown next to each table in the Schema step's List view. Leaving it as
"none" (the default) means that table is always read in full, exactly as
before this feature existed; a table with no watermark column configured
produces byte-identical generated code to what came out before this was
added.

When configured, the generated script tracks the last-processed watermark
per table in a small MongoDB collection, `_migration_state`
(`{_id: "<table name>", lastWatermark: ...}`), and narrows reads instead of
always reading everything:

- **Root table only** (no embeds, or none of them have a watermark
  configured): the root read is filtered to `watermarkColumn >=
  last_watermark` directly, and only that changed subset is written.
- **Root + embeds**: filtering only the root's own read isn't correct on
  its own — a row whose *embedded child* changed, with the parent row
  itself untouched, would be silently skipped, producing a stale nested
  document forever. So instead: rows changed in the root **and** rows
  changed in any watermark-configured embedded child (child FK columns
  mapped positionally onto the root's primary key — the exact
  `embed.foreignKey[i]` ↔ `collection.primaryKey[i]` correspondence
  composite keys already use for the embed join) are unioned into a
  `keys_to_reprocess` set. The root is then read in full and narrowed via
  an inner join against that key set, so every parent whose *own* row or
  *any* embedded child changed gets its full current document rebuilt —
  the same "child changed, parent didn't" case that motivated building
  SCD2 in the first place, now handled on the read side too. Embedded
  child tables themselves are still read in full each run (only the root
  narrows) — a further refinement, not core to this round.
- **Reference tables**: filtered independently and directly by their own
  watermark column, if configured — there's no embed/union complexity
  since a reference isn't joined into anything else.
- **First run** (no stored watermark yet): every filter is skipped, so it
  reads and writes everything and seeds `_migration_state`, then narrows
  on every subsequent run.
- **Composite keys**: nothing new to build here — the union and the
  narrowing join both operate on `collection.primaryKey`/
  `embed.foreignKey` as complete column arrays, reusing the same
  multi-column join pattern already built for the embed join and for
  SCD2's `business_key_cols`.

This still doesn't detect **deletes** — a source row disappearing has no
timestamp to be caught by, same limitation as plain Incremental. As with
SCD2, nothing here enforces a business-key uniqueness constraint at the
database level; a compound unique index (e.g.
`db.customers.createIndex({id: 1}, {unique: true})`, or the composite
equivalent) on each collection's business key is recommended.

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

### One-click version, from the UI

The Glue-job step has a **"Run it locally now"** section below the script
preview — the same mechanism as `scripts/test-local-glue.sh` above, triggered
by a button instead of a terminal command, with a choice of three local
Docker engines:

- **Glue** — `amazon/aws-glue-libs:glue_libs_4.0.0_image_01`, exactly what
  the manual script above uses. Postgres/MySQL JDBC driver and the MongoDB
  Spark Connector are already bundled.
- **EMR Serverless** and **EMR on EKS** — AWS's two distinct, official EMR
  base images (`public.ecr.aws/emr-serverless/spark/emr-7.0.0` and
  `public.ecr.aws/emr-on-eks/spark/emr-7.0.0`, both pulled from public ECR).
  There's no single "EMR-local" image the way Glue has one — these are
  AWS's real base images for its two different EMR deployment products
  (on-demand serverless vs. a Kubernetes cluster), both confirmed to
  actually run the generated transformation logic correctly. Neither has
  the `awsglue` package, so both run a plain-PySpark variant (`SparkSession`
  instead of `GlueContext`/`Job`) produced by a second local-only transform
  script, `scripts/make_emr_local_variant.py`; neither bundles the JDBC
  driver or Mongo connector, so those are resolved from Maven Central via
  `spark-submit --packages` at run time (meaning the first EMR run of
  either kind is slower than Glue's, while those packages download). The
  two also differ from each other in one way worth knowing: EMR Serverless
  only needs `.master("local[*]")` set inside the script to run locally,
  while EMR on EKS's `spark-submit` defaults to a real Kubernetes master and
  cluster deploy mode at the command-line level, so forcing it local also
  needs explicit `--master`/`--deploy-mode` flags — handled automatically,
  just worth knowing if you ever run either image yourself outside this
  tool.

Either way, `localhost`/`127.0.0.1` in the JDBC host or Mongo URI fields is
rewritten to `host.docker.internal` automatically for this button specifically
(the "Generate"/"Download" script is left exactly as typed, since that one's
meant for wherever you actually deploy it) — no need to remember to do that
switch yourself. No cloud account, no cost, nothing touched besides Docker
and whatever local database/Mongo you already have running.

## Roadmap

Five larger items, in rough build order (smallest/most contained first):

1. ~~**Table selection**~~ — **done.** Pick which tables (of possibly 100+)
   actually carry into the Mapping step and generated job via checkboxes at
   the top of the Schema step ("Select all"/"Deselect all" included),
   instead of every introspected table being forced in. Introspection
   itself still reads everything (cheap metadata); the selection is a
   client-side filter (`workingSchema` in `App.jsx`) applied before the
   schema reaches Mapping or `/api/generate-glue-job`.
2. ~~**Full vs. incremental load**~~ — **done**, three load modes. A
   load-mode toggle in the Glue-job step generates the original
   `mode("overwrite")` script, an upsert-by-primary-key variant
   (`mode("append")` + `idFieldList`), or a Slowly Changing Dimension Type 2
   (SCD2) variant that preserves history instead of replacing in place. An
   optional per-table watermark column additionally narrows what
   Incremental/SCD2 read and write to just rows changed since the last run
   — see "Watermark-based incremental extract" under "Using the generated
   Glue job" above for the exact tradeoffs and the embed/composite-key
   handling.
3. **Additional relational sources** — beyond Postgres/MySQL (e.g. SQL
   Server, Oracle). Each new engine needs its own `information_schema`-
   equivalent introspection queries and JDBC driver wired into the
   generated script.
4. ~~**Computed/derived columns**~~ — **done.** A column that doesn't exist
   in the source, whose value is instead a free-form Spark SQL expression
   the user writes in the Schema step (concatenating two columns, defaulting
   to `CURRENT_DATE()`, or anything else `expr()` supports) — see "Computed
   / derived columns" below for the full details, validation, and the SCD2
   interaction to be aware of.
5. ~~**Direct deployment**~~ — **done, as one-click local execution.** A
   real cloud SDK integration (creating actual AWS/GCP resources and
   billed jobs) was scoped and then deliberately dropped in favor of
   something that fit this tool's zero-cost, locally-verifiable spirit much
   better: a "Run it locally now" button that actually executes the
   generated script, for real, via Docker — a choice of AWS's own local Glue
   4.0 image or its official EMR Serverless base image — with no cloud
   account and no cost. See "One-click version, from the UI" above.

## Known gaps

- Glue-only — no EMR/Dataproc generator yet
- Neither Incremental nor SCD2 delete a target document whose source row was
  deleted — a watermark column has no way to notice a row's absence, only
  its change (same gap the separate anti-join/CDC discussion covers)
- MongoDB's own `_id` (a BSON ObjectId) doesn't round-trip cleanly through
  the Spark Connector — reading it back gives a bare hex string with no
  type marker, and writing that string back doesn't get reinterpreted as
  the original ObjectId (confirmed by testing: `idFieldList="_id"` silently
  inserted a new malformed document instead of matching the existing one).
  SCD2's own version-matching works around this with a self-generated
  `_versionId` field instead of `_id`; keep this in mind if extending any
  future feature that needs to reference a specific existing document by
  its Mongo `_id` from within Spark.
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

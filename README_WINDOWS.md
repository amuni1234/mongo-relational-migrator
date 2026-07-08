# Running Relational → MongoDB Migrator on Windows

## Prerequisites

- Docker Desktop
- Node.js 20+
- Python 3
- Git Bash (recommended)
- VS Code

---

## Clone Repository

```bash
git clone <repo-url>
cd mongo-relational-migrator
```

---

## Start PostgreSQL

```bash
docker run ...
```

---

## Start MongoDB

```bash
docker run ...
```

---

## Backend

```bash
cd backend
copy .env.example .env
npm install
npm run dev
```

---

## Frontend

```bash
cd frontend
npm install
npm run dev
```

---

## Open UI

http://localhost:5173

---

## Seed PostgreSQL

Run the SQL script.

---

## Test Migration

1. Connect to PostgreSQL
2. Introspect Schema
3. Review Mapping
4. Generate Glue Script
5. Test Load

---

## Running Local Glue Test

Run:

```bash
bash scripts/test-local-glue.sh
```

### Known Issue (Git Bash)

Git Bash converts Linux paths into Windows paths.

Example error:

```
python.exe: can't open file
```

Possible workaround:

```
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"
```

This issue still requires further investigation.

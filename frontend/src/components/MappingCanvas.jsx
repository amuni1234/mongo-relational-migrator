import { useEffect, useMemo, useState } from "react";

/**
 * A visual mapping editor styled after MongoDB Relational Migrator's
 * "Mapping" tab: a relational schema diagram on the left, the resulting
 * MongoDB collection diagram on the right, and a mapping detail sidebar.
 *
 * The core interaction: drag a table card in the MongoDB panel and drop it
 * onto another table card there to embed it (e.g. drop "employees" onto
 * "departments" to nest employees as an array inside each department
 * document). Drop it on the empty canvas area to un-embed it back to its
 * own top-level collection. Everything re-renders live, and the sidebar
 * always reflects the currently selected collection.
 */

function pluralize(name) {
  if (name.endsWith("s")) return name;
  if (name.endsWith("y")) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

export default function MappingCanvas({ schema, onChange, onContinue }) {
  const tableByName = useMemo(
    () => new Map(schema.tables.map((t) => [t.name, t])),
    [schema]
  );

  // tableName -> parentTableName it's currently embedded into (or undefined
  // if it's still its own top-level collection).
  const [embeddedIn, setEmbeddedIn] = useState(() => inferInitialEmbeds(schema));
  const [collectionNames, setCollectionNames] = useState(() => {
    const names = {};
    for (const t of schema.tables) names[t.name] = pluralize(t.name);
    return names;
  });
  // childTableName -> "one" | "many", only present once the user has
  // manually overridden the inferred cardinality for that embed.
  const [cardinalityOverride, setCardinalityOverride] = useState({});
  const [selected, setSelected] = useState(schema.tables[0]?.name || null);
  const [dragOverTable, setDragOverTable] = useState(null);
  const [addPickerOpenFor, setAddPickerOpenFor] = useState(null);

  // Sync the parent's mapping state with our initial (heuristic-seeded)
  // embed state, so downstream steps see the same thing the canvas shows
  // even if the user never drags anything.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    onChange(buildLegacyMapping(schema, embeddedIn, collectionNames, cardinalityOverride));
  }, []);

  const topLevelTables = schema.tables.filter((t) => !embeddedIn[t.name]);

  function childrenOf(tableName) {
    return schema.tables.filter((t) => embeddedIn[t.name] === tableName);
  }

  function isDescendantOf(candidateAncestor, tableName) {
    let cur = tableName;
    const guard = new Set();
    while (embeddedIn[cur]) {
      if (guard.has(cur)) return false; // cycle guard
      guard.add(cur);
      if (embeddedIn[cur] === candidateAncestor) return true;
      cur = embeddedIn[cur];
    }
    return false;
  }

  function embed(childTable, parentTable) {
    if (childTable === parentTable) return;
    if (isDescendantOf(childTable, parentTable)) return; // would create a cycle
    const next = { ...embeddedIn, [childTable]: parentTable };
    setEmbeddedIn(next);
    emitChange(next, collectionNames, cardinalityOverride);
    setSelected(parentTable);
  }

  function unembed(childTable) {
    const next = { ...embeddedIn };
    delete next[childTable];
    setEmbeddedIn(next);
    emitChange(next, collectionNames, cardinalityOverride);
    setSelected(childTable);
  }

  function renameCollection(tableName, newName) {
    const next = { ...collectionNames, [tableName]: newName };
    setCollectionNames(next);
    emitChange(embeddedIn, next, cardinalityOverride);
  }

  function setCardinality(childTable, value) {
    const next = { ...cardinalityOverride, [childTable]: value };
    setCardinalityOverride(next);
    emitChange(embeddedIn, collectionNames, next);
  }

  function emitChange(embedState, nameState, cardinalityState) {
    onChange(buildLegacyMapping(schema, embedState, nameState, cardinalityState));
  }

  function handleDragStart(e, tableName) {
    e.dataTransfer.setData("text/table", tableName);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDropOnTable(e, targetTable) {
    e.preventDefault();
    e.stopPropagation();
    setDragOverTable(null);
    const dragged = e.dataTransfer.getData("text/table");
    if (!dragged) return;
    embed(dragged, targetTable);
  }

  function handleDropOnCanvas(e) {
    e.preventDefault();
    setDragOverTable(null);
    const dragged = e.dataTransfer.getData("text/table");
    if (dragged && embeddedIn[dragged]) unembed(dragged);
  }

  function relatedTablesFor(tableName) {
    const table = tableByName.get(tableName);
    const outgoing = table.foreignKeys.map((fk) => fk.refTable);
    const incoming = schema.tables
      .filter((t) => t.foreignKeys.some((fk) => fk.refTable === tableName))
      .map((t) => t.name);
    return [...new Set([...outgoing, ...incoming])];
  }

  function renderRelationalCard(table) {
    return (
      <div className="er-card" key={table.name}>
        <div className="er-card-title">
          <span className="er-dot amber" /> {table.name}
        </div>
        <div className="er-card-body">
          {table.columns.map((c) => (
            <div className="er-row" key={c.name}>
              <span className={c.isPrimaryKey ? "er-col-pk" : "er-col-name"}>
                {c.isPrimaryKey ? "🔑 " : ""}
                {c.name}
              </span>
              <span className="er-col-type">{c.computed ? "computed" : c.dataType}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderMongoCard(table, depth = 0) {
    const children = childrenOf(table.name);
    const isSelected = selected === table.name;

    return (
      <div
        key={table.name}
        className={`er-card mongo ${isSelected ? "selected" : ""} ${
          dragOverTable === table.name ? "drag-over" : ""
        }`}
        style={{ marginLeft: depth * 18 }}
        draggable={depth === 0}
        onDragStart={(e) => depth === 0 && handleDragStart(e, table.name)}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOverTable(table.name);
        }}
        onDragLeave={() => setDragOverTable((cur) => (cur === table.name ? null : cur))}
        onDrop={(e) => handleDropOnTable(e, table.name)}
        onClick={() => setSelected(depth === 0 ? table.name : findRoot(table.name))}
      >
        <div className="er-card-title">
          <span className="er-dot teal" />
          {depth === 0 ? collectionNames[table.name] : table.name}
          {depth === 0 && <span className="er-drag-hint">⠿ drag to embed</span>}
        </div>
        <div className="er-card-body">
          {table.columns.map((c) => (
            <div className="er-row" key={c.name}>
              <span className={c.isPrimaryKey ? "er-col-pk" : "er-col-name"}>
                {c.isPrimaryKey ? "🆔 " : ""}
                {c.name}
              </span>
              <span className="er-col-type">{c.computed ? "computed" : c.dataType}</span>
            </div>
          ))}
          {children.map((child) => {
            const fk = child.foreignKeys.find((fk) => fk.refTable === table.name);
            const isOverridden = child.name in cardinalityOverride;
            const effectiveCardinality =
              cardinalityOverride[child.name] ?? (fk && fk.unique ? "one" : "many");
            return (
              <div className="er-embedded-block" key={child.name}>
                <div className="er-embedded-label">
                  {child.name}{" "}
                  <span className="pill-toggle" onClick={(e) => e.stopPropagation()}>
                    <button
                      className={effectiveCardinality === "one" ? "active" : ""}
                      onClick={() => setCardinality(child.name, "one")}
                    >
                      one
                    </button>
                    <button
                      className={effectiveCardinality === "many" ? "active" : ""}
                      onClick={() => setCardinality(child.name, "many")}
                    >
                      many
                    </button>
                  </span>{" "}
                  <span className="er-muted">{isOverridden ? "(manual)" : "(auto)"}</span>
                  <button
                    className="er-unembed-btn"
                    title="Un-embed"
                    onClick={(e) => {
                      e.stopPropagation();
                      unembed(child.name);
                    }}
                  >
                    ✕
                  </button>
                </div>
                {renderMongoCard(child, depth + 1)}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function findRoot(tableName) {
    let cur = tableName;
    while (embeddedIn[cur]) cur = embeddedIn[cur];
    return cur;
  }

  const selectedTable = selected ? tableByName.get(selected) : null;
  const selectedChildren = selected ? childrenOf(selected) : [];
  const embeddableCandidates = topLevelTables.filter((t) => t.name !== selected);

  return (
    <div className="panel">
      <h2>3. Design the document mapping</h2>
      <p className="hint">
        Drag a collection card on the right and drop it onto another to embed
        it as a nested array — e.g. drop <strong>employees</strong> onto{" "}
        <strong>departments</strong> to nest employees inside each department
        document. Drop a card back onto empty canvas space, or click the ✕ on
        an embedded block, to undo it.
      </p>

      <div className="er-layout">
        <div className="er-panel">
          <div className="er-panel-title">Relational schema</div>
          <div className="er-canvas">
            {schema.tables.map((t) => renderRelationalCard(t))}
          </div>
        </div>

        <div
          className="er-panel"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDropOnCanvas}
        >
          <div className="er-panel-title">MongoDB collections</div>
          <div className="er-canvas">
            {topLevelTables.map((t) => renderMongoCard(t, 0))}
          </div>
        </div>

        <div className="er-sidebar">
          <div className="er-panel-title">Mappings</div>
          {!selectedTable && (
            <p className="hint" style={{ marginTop: 8 }}>
              Select a collection to view its mapping.
            </p>
          )}
          {selectedTable && (
            <>
              <label style={{ marginTop: 8 }}>MongoDB collection</label>
              <label style={{ marginTop: 0, color: "var(--muted)" }}>Name</label>
              <input
                type="text"
                value={collectionNames[findRoot(selectedTable.name)]}
                onChange={(e) =>
                  renameCollection(findRoot(selectedTable.name), e.target.value)
                }
              />

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                <label style={{ margin: 0 }}>Mappings from relational tables</label>
                <button
                  className="btn secondary"
                  style={{ padding: "4px 10px", fontSize: 12 }}
                  onClick={() =>
                    setAddPickerOpenFor(addPickerOpenFor === selected ? null : selected)
                  }
                  disabled={embeddableCandidates.length === 0}
                >
                  + Add
                </button>
              </div>

              {addPickerOpenFor === selected && (
                <div style={{ marginBottom: 10 }}>
                  {embeddableCandidates.length === 0 && (
                    <div className="hint">No other unmapped tables available.</div>
                  )}
                  {embeddableCandidates.map((t) => (
                    <button
                      key={t.name}
                      className="btn secondary"
                      style={{ display: "block", width: "100%", marginBottom: 6, textAlign: "left" }}
                      onClick={() => {
                        embed(t.name, findRoot(selected));
                        setAddPickerOpenFor(null);
                      }}
                    >
                      Embed {t.name}
                    </button>
                  ))}
                </div>
              )}

              <div className="mapping-list-item">
                <span>🗂 {findRoot(selectedTable.name)}</span>
                <span className="er-muted">root</span>
              </div>
              {selectedChildren.map((child) => (
                <div className="mapping-list-item" key={child.name}>
                  <span>↳ {child.name}</span>
                  <button className="er-unembed-btn" onClick={() => unembed(child.name)}>
                    🗑
                  </button>
                </div>
              ))}

              <div className="hint" style={{ marginTop: 14 }}>
                Related tables: {relatedTablesFor(selectedTable.name).join(", ") || "none"}
              </div>
            </>
          )}
        </div>
      </div>

      <button className="btn" onClick={onContinue} style={{ marginTop: 20 }}>
        Continue to Glue job →
      </button>
    </div>
  );
}

// Seed a reasonable starting embed state: single-FK, non-growth-named
// tables start embedded into their parent (matches the old heuristic),
// everything else starts as its own top-level collection.
function inferInitialEmbeds(schema) {
  const HIGH_GROWTH = ["transaction", "order", "log", "event", "interaction", "audit", "history"];
  const embeddedIn = {};
  for (const t of schema.tables) {
    if (t.foreignKeys.length !== 1) continue;
    const nameLower = t.name.toLowerCase();
    if (HIGH_GROWTH.some((h) => nameLower.includes(h))) continue;
    embeddedIn[t.name] = t.foreignKeys[0].refTable;
  }
  return embeddedIn;
}

// Converts the visual embeddedIn/collectionNames state back into the
// { collections: [{ collectionName, rootTable, primaryKey, embeds, references }] }
// shape the Glue job generator expects, so nothing downstream has to change.
function buildLegacyMapping(schema, embeddedIn, collectionNames, cardinalityOverride = {}) {
  const tableByName = new Map(schema.tables.map((t) => [t.name, t]));
  const topLevel = schema.tables.filter((t) => !embeddedIn[t.name]);

  const collections = topLevel.map((root) => {
    const children = schema.tables.filter((t) => embeddedIn[t.name] === root.name);
    const embeds = children.map((child) => {
      const fk = child.foreignKeys.find((fk) => fk.refTable === root.name);
      return {
        table: child.name,
        foreignKey: fk ? fk.columns : [`${root.name}_id`],
        as: pluralize(child.name),
        // A single-column UNIQUE/PRIMARY KEY constraint on the FK column
        // means at most one child row per parent (one-to-one) -- unless
        // the user explicitly overrode it in the UI.
        cardinality: cardinalityOverride[child.name] ?? (fk && fk.unique ? "one" : "many"),
      };
    });
    return {
      collectionName: collectionNames[root.name] || pluralize(root.name),
      rootTable: root.name,
      primaryKey: root.primaryKey,
      embeds,
      references: [],
    };
  });

  return { collections };
}

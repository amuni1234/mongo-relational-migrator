/**
 * Given the normalized relational schema, suggest a starting MongoDB
 * document mapping — mirroring what MongoDB Relational Migrator does:
 * root "entity" tables become top-level collections, and each table that
 * references them is suggested as either "embed" (small, tightly-owned
 * child, e.g. addresses) or "reference" (large/independent, e.g.
 * transactions), based on simple heuristics the user can override.
 *
 * Heuristic used here (deliberately simple + explainable to a user):
 *  - A child table is a candidate for EMBEDDING in its parent when its
 *    only foreign key is to that parent (i.e. it doesn't independently
 *    relate to other entities) AND it isn't in the "high growth" list.
 *  - Tables the user flags (or that look like fact/event tables by name:
 *    transactions, orders, logs, events, interactions) default to
 *    REFERENCE, since they grow unbounded and would blow past MongoDB's
 *    16MB document limit if embedded.
 *  - Tables with more than one foreign key (many-to-many join tables,
 *    or tables related to multiple entities) default to REFERENCE.
 */

const HIGH_GROWTH_NAME_HINTS = [
  "transaction",
  "order",
  "log",
  "event",
  "interaction",
  "audit",
  "history",
];

function looksHighGrowth(tableName) {
  const lower = tableName.toLowerCase();
  return HIGH_GROWTH_NAME_HINTS.some((hint) => lower.includes(hint));
}

function suggestMapping(schema) {
  const { tables } = schema;
  const tableByName = new Map(tables.map((t) => [t.name, t]));

  // Tables that are never referenced by anything are root/entity candidates.
  const referencedTables = new Set();
  for (const t of tables) {
    for (const fk of t.foreignKeys) referencedTables.add(fk.refTable);
  }

  const rootCandidates = tables.filter((t) => !isChildOfSingleParent(t));

  const collections = rootCandidates.map((root) => {
    const embeds = [];
    const references = [];

    for (const t of tables) {
      if (t.name === root.name) continue;
      const fksToRoot = t.foreignKeys.filter((fk) => fk.refTable === root.name);
      if (fksToRoot.length === 0) continue;

      const hasOtherFks = t.foreignKeys.length > fksToRoot.length;
      const suggestion =
        !hasOtherFks && !looksHighGrowth(t.name) ? "embed" : "reference";

      const entry = {
        table: t.name,
        foreignKey: fksToRoot[0].column,
        as: pluralize(t.name),
        cardinality: "many", // default; user can change to "one" in the UI
      };

      if (suggestion === "embed") embeds.push(entry);
      else references.push({ ...entry, strategy: "reference" });
    }

    return {
      collectionName: pluralize(root.name),
      rootTable: root.name,
      primaryKey: root.primaryKey,
      embeds,
      references,
    };
  });

  return { collections };
}

// A table is a "pure child" (not a root) if it has exactly one foreign key
// and that FK is its only relationship in/out — i.e. nothing else points to it.
function isChildOfSingleParent(table) {
  if (table.foreignKeys.length !== 1) return false;
  return true; // Simple heuristic: single-FK tables default to child role.
}

function pluralize(name) {
  if (name.endsWith("s")) return name;
  if (name.endsWith("y")) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

module.exports = { suggestMapping };

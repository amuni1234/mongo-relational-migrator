/**
 * Pure layout logic for the ER diagram (no React/DOM) -- computes a simple
 * tiered layout from a schema's foreign keys. Tens of tables, not a large
 * graph, so a fixed-point peel + single ordering pass is enough; no need
 * for a real graph-drawing library.
 */

// Every non-self FK becomes an edge; self-referencing FKs (a table pointing
// at itself) never affect tiering and are drawn as a loop, not a line
// between tiers -- kept separate.
function buildEdges(tables) {
  const edges = [];
  const selfEdges = [];
  for (const table of tables) {
    for (const fk of table.foreignKeys) {
      const edge = {
        from: table.name,
        to: fk.refTable,
        column: fk.column,
        refColumn: fk.refColumn,
        synthetic: !!fk.synthetic,
      };
      if (fk.refTable === table.name) selfEdges.push(edge);
      else edges.push(edge);
    }
  }
  return { edges, selfEdges };
}

// Tier 0 = tables with no outgoing edges (referencing nothing). Tier N =
// tables whose every outgoing edge already points into a tier < N. Peel
// tables into tiers until nothing more can be placed; anything left over
// (a genuine multi-table FK cycle) is dumped into one final tier so this
// always terminates.
function computeTiers(tables, edges) {
  const outgoingByTable = new Map(tables.map((t) => [t.name, new Set()]));
  for (const edge of edges) {
    if (outgoingByTable.has(edge.from)) outgoingByTable.get(edge.from).add(edge.to);
  }

  const placed = new Set();
  const tiers = [];
  let remaining = tables.map((t) => t.name);

  while (remaining.length > 0) {
    const tier = remaining.filter((name) => {
      const outgoing = outgoingByTable.get(name);
      return [...outgoing].every((target) => placed.has(target) || target === name);
    });

    if (tier.length === 0) {
      // Cycle: nothing more can be resolved -- dump the rest into one tier.
      tiers.push(remaining);
      break;
    }

    tiers.push(tier);
    for (const name of tier) placed.add(name);
    remaining = remaining.filter((name) => !tier.includes(name));
  }

  return tiers;
}

// Single top-down pass: from tier 1 onward, reorder each tier by the
// average position of each table's edge targets in the tier(s) above (a
// standard first-pass barycenter heuristic) -- keeps a 10-15 table diagram
// from crisscrossing into illegibility without true crossing-minimization.
function orderWithinTiers(tiers, edges) {
  const positionOf = new Map();
  tiers[0]?.forEach((name, i) => positionOf.set(name, i));

  const ordered = [tiers[0] || []];
  for (let t = 1; t < tiers.length; t++) {
    const targetsByTable = new Map();
    for (const edge of edges) {
      if (!tiers[t].includes(edge.from)) continue;
      if (!targetsByTable.has(edge.from)) targetsByTable.set(edge.from, []);
      const pos = positionOf.get(edge.to);
      if (pos !== undefined) targetsByTable.get(edge.from).push(pos);
    }

    const tier = [...tiers[t]].sort((a, b) => {
      const avg = (name) => {
        const targets = targetsByTable.get(name);
        if (!targets || targets.length === 0) return Number.MAX_SAFE_INTEGER;
        return targets.reduce((sum, p) => sum + p, 0) / targets.length;
      };
      return avg(a) - avg(b);
    });

    tier.forEach((name, i) => positionOf.set(name, i));
    ordered.push(tier);
  }

  return ordered;
}

export { buildEdges, computeTiers, orderWithinTiers };

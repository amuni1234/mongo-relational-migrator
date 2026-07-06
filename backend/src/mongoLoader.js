/**
 * Loads a small sample of already-transformed documents into MongoDB so a
 * user can eyeball the shape of the result before committing to a full
 * Glue job run. This does NOT read from the relational source itself
 * (that's Spark's job in the generated Glue script) — it accepts documents
 * the frontend already assembled from a schema preview, and writes them to
 * a scratch collection.
 */

const { MongoClient } = require("mongodb");

async function testLoad({ uri, database, collection, documents }) {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(database);
    const coll = db.collection(collection);

    await coll.deleteMany({}); // scratch collection: always start clean
    if (documents.length > 0) {
      await coll.insertMany(documents, { ordered: false });
    }

    const count = await coll.countDocuments();
    const sample = await coll.find({}).limit(5).toArray();

    return { insertedCount: documents.length, totalInCollection: count, sample };
  } finally {
    await client.close();
  }
}

module.exports = { testLoad };

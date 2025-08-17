// --- Neo4j Aura Proxy (Bolt over TLS) ---
// Exposes:
//   GET  /health          -> driver connectivity check
//   POST /query           -> { cypher: "...", params?: { ... } }
//   GET  /debug/bolt      -> raw TCP connectivity to :7687
//   GET  /debug/tls       -> TLS handshake to :7687
//   GET  /debug/driver    -> driver.verify_connectivity()

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const neo4j = require('neo4j-driver');
const net = require('net');
const tls = require('tls');

// ---------- ENV ----------
const NEO4J_URI  = process.env.NEO4J_URI  || 'neo4j+s://bc0d0426.databases.neo4j.io';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || '';
const NEO4J_DB = process.env.NEO4J_DB || 'neo4j';
// If your host blocks IPv6, force IPv4 by resolving to host:7687 here:
const NEO4J_HOST = process.env.NEO4J_HOST || 'bc0d0426.databases.neo4j.io';
// Allow your frontends to call this proxy (comma-separated)
const ORIGIN_ALLOW_LIST = (process.env.ORIGIN_ALLOW_LIST || 'https://nettedletters.org,https://tool.nettedletters.org')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!NEO4J_PASSWORD) {
  console.error('⚠️  Missing NEO4J_PASSWORD env var'); // continue but will fail at runtime
}

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// CORS so your Unity WebGL page can call the proxy
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ORIGIN_ALLOW_LIST.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin), false);
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// ---- Neo4j driver (Bolt over TLS) ----
// connectionTimeout so failures return quickly during testing
// resolver forces IPv4/explicit host if your platform has IPv6 issues.
const driver = neo4j.driver(
  NEO4J_URI,
  neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
  {
    connectionTimeout: 8000,
    resolver: address => [ `${NEO4J_HOST}:7687` ]
  }
);

// Serialize Neo4j values to JSON-safe
function serialize(v) {
  if (v == null) return null;
  if (neo4j.isInt(v)) return v.inSafeRange() ? v.toNumber() : v.toString();
  if (Array.isArray(v)) return v.map(serialize);
  if (typeof v === 'object') {
    if (v.properties) {
      const out = {};
      for (const [k, val] of Object.entries(v.properties)) out[k] = serialize(val);
      return out;
    }
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = serialize(val);
    return out;
  }
  return v;
}

// ---------- Routes ----------
app.get('/health', async (_req, res) => {
  try {
    await driver.verifyConnectivity();
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post('/query', async (req, res) => {
  const cypher = req.body?.cypher;
  const params = req.body?.params || {};
  if (!cypher) return res.status(400).json({ error: "Missing 'cypher' in body." });

  const session = driver.session({ database: NEO4J_DB });
  try {
    const result = await session.run(cypher, params);

    const columns = result.records.length ? result.records[0].keys : [];
    const data = result.records.map(rec => ({
      row: columns.map(k => serialize(rec.get(k)))
    }));

    // Return in Neo4j HTTP API-like shape (so your Unity parsers work)
    res.json({ results: [{ columns, data }], errors: [] });
  } catch (err) {
    console.error('Neo4j run error:', err);
    res.status(400).json({
      results: [],
      errors: [{ code: err.code || 'QueryError', message: err.message }]
    });
  } finally {
    await session.close();
  }
});

// ---- Diagnostics ----
app.get('/debug/bolt', (req, res) => {
  const s = new net.Socket();
  s.setTimeout(4000);
  s.once('connect', () => { s.destroy(); res.json({ connect: true }); });
  s.once('timeout', () => { s.destroy(); res.status(504).json({ connect: false, error: 'timeout' }); });
  s.once('error', (e) => { s.destroy(); res.status(502).json({ connect: false, error: e.message }); });
  s.connect(7687, NEO4J_HOST);
});

app.get('/debug/tls', (req, res) => {
  const sock = tls.connect(
    { host: NEO4J_HOST, port: 7687, servername: NEO4J_HOST, timeout: 6000 },
    () => {
      const info = { authorized: sock.authorized, alpnProtocol: sock.alpnProtocol || null, cipher: sock.getCipher() };
      sock.destroy();
      res.json({ ok: true, info });
    }
  );
  sock.on('error', e => { res.status(502).json({ ok: false, error: e.message }); });
  sock.on('timeout', () => { sock.destroy(); res.status(504).json({ ok: false, error: 'timeout' }); });
});

app.get('/debug/driver', async (_req, res) => {
  try {
    await driver.verifyConnectivity();
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Graceful shutdown
process.on('SIGINT', async () => { await driver.close(); process.exit(0); });
process.on('SIGTERM', async () => { await driver.close(); process.exit(0); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Neo4j Bolt proxy listening on :${PORT}`);
  console.log(`   URI=${NEO4J_URI} DB=${NEO4J_DB} HOST=${NEO4J_HOST}`);
});

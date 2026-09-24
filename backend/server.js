const express = require('express');
const cors = require('cors');
const { initDb } = require('./db/init');

const authRoutes = require('./routes/auth');
const boardRoutes = require('./routes/boards');
const columnRoutes = require('./routes/columns');
const cardRoutes = require('./routes/cards');

const DEFAULT_PORT = 3002;

function createApp() {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Initialize database
  const db = initDb();

  // Health check (before auth-protected routes)
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/boards', boardRoutes);
  app.use('/api', columnRoutes);
  app.use('/api', cardRoutes);

  // Error handler
  app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, db };
}

function start(port = process.env.PORT || DEFAULT_PORT) {
  const { app, db } = createApp();
  const server = app.listen(port, () => {
    console.log(`Task Board API running on http://localhost:${port}`);
  });

  return {
    app,
    server,
    stop() {
      return new Promise((resolve) => {
        const done = () => {
          try { db.close(); } catch { /* 已关闭 */ }
          resolve();
        };
        if (!server.listening) {
          done();
          return;
        }
        server.close(done);
        // Do not keep the process alive for idle/lingering connections
        server.closeAllConnections && server.closeAllConnections();
      });
    }
  };
}

// Start directly (node server.js / npm run dev) — behaviour unchanged
if (require.main === module) {
  start();
}

module.exports = { createApp, start, DEFAULT_PORT };

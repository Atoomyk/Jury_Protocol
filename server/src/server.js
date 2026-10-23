'use strict';

const { loadConfig } = require('./config');
const { openDatabase } = require('./db/database');
const { createApp } = require('./app');

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[server] конфигурация: ${err.message}`);
    process.exit(1);
  }

  const db = openDatabase(config.databasePath);
  const app = createApp({ db, config });

  const server = app.listen(config.port, config.host, () => {
    console.log(`[server] слушает ${config.host}:${config.port}`);
    if (!['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
      console.warn('[server] HOST не loopback: убедитесь, что порт закрыт файрволом и доступен только через nginx');
    }
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();

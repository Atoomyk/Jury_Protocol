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

  const server = app.listen(config.port, () => {
    console.log(`[server] слушает порт ${config.port}`);
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

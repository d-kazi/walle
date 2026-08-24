import { rebuildDb } from '../src/db/rebuild.js';

const dataDir = process.env.DATA_DIR ?? '/data';
rebuildDb(dataDir)
  .then((count) => {
    console.log(`Rebuilt ${dataDir}/db/walle.db from ${count} events.`);
  })
  .catch((err) => {
    console.error('Rebuild failed:', err);
    process.exit(1);
  });

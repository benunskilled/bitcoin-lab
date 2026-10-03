'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// On a fresh install all four services start at once and open the same, not
// yet existing, database. Each one switches it to WAL, creates the schema,
// runs the migrations and seeds the pools - and every one of those steps used
// to be able to fail with SQLITE_BUSY in the losers of the race, taking the
// process down on its first boot.
const OPEN = `
  const db = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'lib', 'db'))});
  db.open();
  db.instance.close();
`;

function openOnce(dbPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', OPEN], {
      env: { ...process.env, SQLITE_PATH: dbPath, DATA_DIR: path.dirname(dbPath), LOG_LEVEL: 'error' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('four processes opening a fresh database at once all start', { timeout: 120_000 }, async () => {
  const failures = [];
  for (let round = 0; round < 15; round++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-first-start-'));
    const dbPath = path.join(dir, 'sqlite', 'bitcoinlab.db');
    const results = await Promise.all([1, 2, 3, 4].map(() => openOnce(dbPath)));
    for (const r of results) if (r.code !== 0) failures.push(r.stderr.split('\n').find((l) => /Error/.test(l)) || `exit ${r.code}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(failures, [], `${failures.length} of 60 processes failed to start`);
});

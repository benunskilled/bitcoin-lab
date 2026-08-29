'use strict';

// Dev tooling, not part of the running app (see seed-demo-data.js). A
// two-line stand-in for Bitcoin Core's JSON-RPC server: dashboard-server.js
// hits real RPC once, for getblockcount on /api/status, and nothing else
// on this server needs a live node. Without this the demo dashboard's
// "Block Height" tile stays blank, which is the opposite of what a
// screenshot is for.

const http = require('http');

const port = Number(process.env.MOCK_RPC_PORT || 18332);
const height = Number(process.env.MOCK_RPC_HEIGHT || 921845);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let id = null;
    try { id = JSON.parse(body).id; } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: height, error: null, id }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock RPC serving getblockcount=${height} on 127.0.0.1:${port}`);
});

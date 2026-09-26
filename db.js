// Minimal file-based store so paid orders survive a server restart.
// This is fine to get started, but for real production traffic swap this
// for a proper database (Postgres/SQLite/etc.) — see README.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'orders.json');

function readAll() {
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function getOrder(orderId) {
  const all = readAll();
  return all[orderId];
}

function setOrder(orderId, data) {
  const all = readAll();
  all[orderId] = { ...all[orderId], ...data };
  writeAll(all);
}

module.exports = { getOrder, setOrder };

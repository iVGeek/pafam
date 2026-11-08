// One-off: print a quick summary of the local database state.
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const dbPath = process.argv[2] || path.join(__dirname, "..", "data", "ptp.db");
const db = new DatabaseSync(dbPath, { readOnly: true });

const tables = [
  "suppliers",
  "uploads",
  "offers",
  "products",
  "customers",
  "demands",
  "quotes",
  "orders",
  "payments",
  "inventory_lots",
  "reservations",
  "shipments",
  "alerts",
  "tasks",
  "captures",
  "price_history",
  "users",
];

for (const t of tables) {
  try {
    const r = db.prepare(`select count(*) c from "${t}"`).get();
    console.log(`${t.padEnd(16)} ${r.c}`);
  } catch (e) {
    console.log(`${t.padEnd(16)} ERR ${e.message}`);
  }
}

console.log("---");
try {
  const brands = db
    .prepare('select coalesce(brand, "(none)") b, count(*) c from products group by 1 order by c desc limit 8')
    .all();
  console.log("Top brands: " + brands.map((r) => `${r.b} (${r.c})`).join(" | "));
} catch {
  /* older schema */
}

try {
  const sup = db.prepare("select name from suppliers").all();
  console.log("Suppliers: " + sup.map((s) => s.name).join(", "));
} catch {
  /* n/a */
}

try {
  const up = db.prepare("select filename from uploads order by id desc limit 5").all();
  console.log("Latest uploads: " + up.map((u) => u.filename).join(", "));
} catch {
  /* n/a */
}
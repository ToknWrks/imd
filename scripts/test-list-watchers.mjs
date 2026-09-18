import Database from "better-sqlite3";

const db = new Database("data/accumulate.db", { readonly: true });
const rows = db.prepare("SELECT id, symbol, contract_address, pool_address, active FROM dip_watchers").all();
console.log(JSON.stringify(rows, null, 2));

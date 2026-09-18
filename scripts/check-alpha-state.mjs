// Read-only check of the alpha engine's cache state.
const c = JSON.parse((await import("fs")).readFileSync("data/alpha-cache.json", "utf8"));
const launches = c.chain?.launches || [];
const longs = launches.filter(l => (l.protocol || "").toUpperCase() === "LONG");
console.log("chain lastSync:", (c.sources.chain?.lastSync || "").slice(11, 19), "| now:", new Date().toISOString().slice(11, 19));
console.log("dex lastSync:", (c.sources.dex?.lastSync || "").slice(11, 19), "| security:", (c.sources.security?.lastSync || "").slice(11, 19), "(", Object.keys(c.security || {}).length, "tokens analyzed )");
console.log("cache launches:", launches.length, "| LONG in cache:", longs.length);
console.log("alpha:", c.alpha.length, "| graduated:", c.alpha.filter(t => t.graduated).length);
const grads = c.alpha.filter(t => t.graduated);
console.log("graduated:", grads.map(t => (t.protocol || "?") + ":" + (t.symbol || t.token?.slice(0, 6) || "?")).slice(0, 12).join(", "));

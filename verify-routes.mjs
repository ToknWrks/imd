/**
 * verify-routes.mjs — /verify page + /api/verify/* handlers.
 * Same contract as sniper/mm route modules: return true when handled.
 */
import { listVerifyChecks, setVerifyStatus, resetVerifySection, verifySummary } from "./verify-db.mjs";
import { verifyPage } from "./verify-page.mjs";

export async function handleVerifyRequest(url, method, { readBody, json, send, shell, esc }) {
  if (url === "/verify" && method === "GET") {
    send(verifyPage({ shell, esc }));
    return true;
  }

  if (url === "/api/verify/status" && method === "POST") {
    try {
      const { id, status, note } = JSON.parse(await readBody());
      const row = setVerifyStatus(String(id ?? ""), String(status ?? ""), note ?? null);
      json({ ok: true, check: row });
    } catch (e) { json({ ok: false, error: e.message }); }
    return true;
  }

  if (url === "/api/verify/reset" && method === "POST") {
    try {
      const { section } = JSON.parse(await readBody());
      resetVerifySection(String(section ?? ""));
      json({ ok: true, summary: verifySummary() });
    } catch (e) { json({ ok: false, error: e.message }); }
    return true;
  }

  if (url === "/api/verify/checks" && method === "GET") {
    json({ ok: true, checks: listVerifyChecks(), summary: verifySummary() });
    return true;
  }

  return false;
}

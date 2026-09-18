/**
 * verify-page.mjs — /verify page markup. Groups the checklist by section with
 * per-item status pills (pending/pass/fail), click-to-cycle + note editing,
 * section reset, and a progress header. Follows sniper/mm page conventions.
 */
import { listVerifyChecks, verifySummary } from "./verify-db.mjs";

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

const PILL = {
  pending: '<span class="pill off" data-role="pill">pending</span>',
  pass: '<span class="pill on" data-role="pill">pass</span>',
  fail: '<span class="pill" style="color:#f87171;border-color:rgba(248,113,113,.35)" data-role="pill">fail</span>',
};

export function verifyPage({ shell, esc: shellEsc }) {
  const checks = listVerifyChecks();
  const sum = verifySummary();
  const escFn = shellEsc || esc;

  const sections = [...new Set(checks.map((c) => c.section))].map((section) => {
    const items = checks.filter((c) => c.section === section);
    const passed = items.filter((i) => i.status === "pass").length;
    const rows = items.map((c) => `
      <tr data-id="${esc(c.id)}" data-status="${esc(c.status)}">
        <td style="width:8%">
          <div style="display:flex;gap:0.3rem">
            <button type="button" class="secondary" style="padding:0.25rem 0.5rem;font-size:0.7rem" onclick="cycleStatus('${esc(c.id)}')">✓</button>
            <button type="button" class="secondary" style="padding:0.25rem 0.5rem;font-size:0.7rem" onclick="markFail('${esc(c.id)}')">✗</button>
          </div>
        </td>
        <td>
          <div style="font-weight:600">${escFn(c.label)}</div>
          <div class="hint">${escFn(c.hint ?? "")}</div>
          ${c.note ? `<div class="hint" style="color:#e8b661">note: ${escFn(c.note)}</div>` : ""}
          ${c.updated_at ? `<div class="hint" style="opacity:.6">${escFn(c.updated_at)}</div>` : ""}
        </td>
        <td style="width:12%">${PILL[c.status] || PILL.pending}</td>
      </tr>`).join("");
    return `
      <div class="card">
        <h2 style="display:flex;justify-content:space-between;align-items:center">
          <span>${escFn(section)} <span class="hint">${passed}/${items.length} pass</span></span>
          <button type="button" class="secondary" style="padding:0.3rem 0.7rem;font-size:0.72rem" onclick="resetSection('${escFn(section)}')">reset section</button>
        </h2>
        <table><thead><tr><th style="width:8%">Mark</th><th>Check</th><th style="width:12%">Status</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
  }).join("");

  const pct = sum.total > 0 ? Math.round(((sum.passed ?? 0) / sum.total) * 100) : 0;

  return shell("Verify", `
    <style>
      .vbar { height:10px; background:rgba(255,255,255,.07); border-radius:5px; overflow:hidden; margin-top:0.4rem; }
      .vbar > div { height:100%; background:#4ade80; width:${pct}%; transition:width .3s; }
      .vbtn { display:flex; gap:0.6rem; align-items:baseline; flex-wrap:wrap; }
    </style>
    <div class="stat-row">
      <div class="stat-card"><div class="label">Progress</div><div class="value">${sum.passed ?? 0}/${sum.total}</div><div class="sub">${pct}% verified</div><div class="vbar"><div></div></div></div>
      <div class="stat-card"><div class="label">Passed</div><div class="value" style="color:#4ade80">${sum.passed ?? 0}</div><div class="sub">marked pass</div></div>
      <div class="stat-card"><div class="label">Failed</div><div class="value" style="color:${(sum.failed ?? 0) > 0 ? "#f87171" : "inherit"}">${sum.failed ?? 0}</div><div class="sub">need attention</div></div>
      <div class="stat-card"><div class="label">Pending</div><div class="value">${sum.pending ?? 0}</div><div class="sub">not yet tested</div></div>
    </div>
    <div class="card">
      <h2>How to use</h2>
      <p class="hint" style="line-height:1.6">
        Work top-to-bottom. <b>✓</b> cycles status → pass; <b>✗</b> marks fail
        (add what happened in the prompt — the note renders under the check).
        Statuses persist in SQLite across restarts. "reset section" clears one
        group back to pending. Live/chain checks stay unchecked until they have
        actually executed — the two execution-path fixes are pattern-verified
        but need their first small live legs before being marked pass.
      </p>
    </div>
    ${sections}
    <script>
      async function setStatus(id, status) {
        const note = status === "fail" ? (prompt("What failed / why?") || "") : null;
        const r = await fetch("/api/verify/status", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id, status, note }) });
        const j = await r.json();
        if (!j.ok) { alert(j.error); return; }
        location.reload();
      }
      function cycleStatus(id) { setStatus(id, "pass"); }
      function markFail(id) { setStatus(id, "fail"); }
      async function resetSection(section) {
        if (!confirm("Reset all checks in '" + section + "' to pending?")) return;
        const r = await fetch("/api/verify/reset", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ section }) });
        const j = await r.json();
        if (!j.ok) alert(j.error); else location.reload();
      }
    </script>
  `, "verify");
}

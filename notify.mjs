/**
 * notify.mjs — minimal alert pusher for operational failures.
 *
 * Phase-1 alerting: WS subscription death, trade failures, low gas. Deliver
 * via Telegram bot API when ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID
 * are set; always log to the console regardless (pm2 logs are the fallback
 * record). Fire-and-forget: alerting must never throw into the caller's path
 * or delay trading.
 *
 * Dedup: identical alerts within ALERT_DEDUPE_MS (default 10 min) are
 * suppressed so a flapping socket doesn't spam — state changes ("recovered")
 * always send.
 */

const TELEGRAM_TOKEN = () => process.env.ALERT_TELEGRAM_BOT_TOKEN?.trim() || "";
const TELEGRAM_CHAT = () => process.env.ALERT_TELEGRAM_CHAT_ID?.trim() || "";
const DEDUPE_MS = () => Math.max(0, Number(process.env.ALERT_DEDUPE_MS ?? 600_000));

const _lastSent = new Map(); // key -> { at, text }

function esc(s) {
  return String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

async function sendTelegram(text) {
  const token = TELEGRAM_TOKEN();
  const chat = TELEGRAM_CHAT();
  if (!token || !chat) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[notify] telegram send failed: ${res.status} ${(await res.text()).slice(0, 140)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[notify] telegram send failed: ${e.message}`);
    return false;
  }
}

/**
 * Push an alert. `key` deduplicates: same key within ALERT_DEDUPE_MS is
 * dropped unless `force` is set. `resolved` marks a recovery — always sent.
 * Returns true when an alert was actually delivered (console always logs).
 */
export async function alert(key, text, { force = false, resolved = false } = {}) {
  const line = `${resolved ? "✅" : "⚠️"} ${text}`;
  const now = Date.now();
  const prev = _lastSent.get(key);
  if (!resolved && !force && prev && now - prev.at < DEDUPE_MS()) return false;
  _lastSent.set(key, { at: now, text });

  console.log(`[notify] ${line}`);
  if (TELEGRAM_TOKEN() && TELEGRAM_CHAT()) await sendTelegram(line);
  return true;
}

/** Seed .env.example-style docs helper — no-op, documents expected vars. */
export const ALERT_ENV_KEYS = ["ALERT_TELEGRAM_BOT_TOKEN", "ALERT_TELEGRAM_CHAT_ID", "ALERT_DEDUPE_MS"];

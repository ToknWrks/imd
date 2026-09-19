/**
 * swap-routes.mjs — /swap page route. Same contract as verify-routes.mjs:
 * return true when handled.
 */
import { swapPage } from "./swap-page.mjs";

export async function handleSwapRequest(url, method, { send, shell }) {
  if (url === "/swap" && method === "GET") {
    send(swapPage({ shell }));
    return true;
  }
  return false;
}

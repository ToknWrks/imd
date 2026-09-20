/**
 * The actual hook implementation, registered by test-loader.mjs via
 * module.register(). Kept in its own file because register() spawns a
 * dedicated hooks thread that imports this file separately.
 *
 * Stub directory: TEST_STUB_DIR env var (relative to repo root), default
 * "stubs". Suites set their own dir (activate → stubs-activate, v2 → stubs-v2)
 * because node --test runs files CONCURRENTLY and a shared stub dir races —
 * whichever suite wrote a stub last silently changed the other's behavior.
 */
import { pathToFileURL } from "url";

const STUB_DIR = process.env.TEST_STUB_DIR || "stubs";

const MAP = {
  "smart-account.mjs": "smart-account.stub.mjs",
  "signer.mjs": "signer.stub.mjs",
  "users.mjs": "users.stub.mjs",
  "smart-wallet-registry.mjs": "registry-v2.stub.mjs",
  "db.mjs": "db.stub.mjs",
  "dip-swap.mjs": "dip-swap.stub.mjs",
  "chains.mjs": "chains.stub.mjs",
};

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".")) {
    for (const [needle, stub] of Object.entries(MAP)) {
      if (specifier === "./" + needle || specifier.endsWith("/" + needle)) {
        const { fileURLToPath } = await import("url");
        const here = fileURLToPath(new URL(".", import.meta.url));
        return { url: pathToFileURL(here + STUB_DIR + "/" + stub).href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}

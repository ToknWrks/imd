/**
 * The actual hook implementation, registered by test-loader.mjs via
 * module.register(). Kept in its own file because register() spawns a
 * dedicated hooks thread that imports this file separately.
 */
import { pathToFileURL } from "url";

const MAP = {
  "smart-account.mjs": "smart-account.stub.mjs",
  "signer.mjs": "signer.stub.mjs",
  "users.mjs": "users.stub.mjs",
  "smart-wallet-registry.mjs": "smart-wallet-registry.stub.mjs",
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
        return { url: pathToFileURL(here + "stubs/" + stub).href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}

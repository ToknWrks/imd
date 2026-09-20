
    // resolveSigner throws like the real one does on hosted (no env signer).
    export async function resolveSigner() {
      const e = new Error("No signer configured — set AGENT_PRIVATE_KEY or VAULT_ACTIVE=true in .env");
      throw e;
    }
    export function invalidateSigner() {}
    export async function resolveSignerUser() { throw new Error("stub: not used in this test"); }
  

    export function encryptSecret(s) { return "enc:" + s; }
    export function decryptSecret(s) { return s.startsWith("enc:") ? s.slice(4) : null; }
    export function getUser() { return { wallet_address: "0x" + "2".repeat(40), signer_mode: "copilot" }; }
    export function getUserSecret() { return null; }
    export function setUserSecret() {}
  
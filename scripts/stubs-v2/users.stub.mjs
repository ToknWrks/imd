
  export function encryptSecret(s) { return "enc:" + s; }
  export function decryptSecret(s) { return s.startsWith("enc:") ? s.slice(4) : null; }
  export function getUser() { return null; }
  export function getUserSecret() { return null; }
  export function setUserSecret() {}

"use strict";

// Mirrors scripts/encrypt_data.py envelope format (v1):
// PBKDF2-SHA256 (200k iters) -> AES-256-GCM.
window.SweatyCrypto = (function () {
  function isEnvelope(payload) {
    return Boolean(
      payload &&
        typeof payload === "object" &&
        typeof payload.ct === "string" &&
        typeof payload.iv === "string" &&
        typeof payload.salt === "string",
    );
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  async function decryptEnvelope(envelope, passphrase) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("This browser does not support Web Crypto; cannot decrypt the dashboard.");
    }
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: b64ToBytes(envelope.salt),
        iterations: Number(envelope.iter) || 200000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(envelope.iv) },
      key,
      b64ToBytes(envelope.ct),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  return { isEnvelope, decryptEnvelope };
})();

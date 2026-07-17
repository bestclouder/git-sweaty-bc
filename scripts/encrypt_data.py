"""Encrypt site/data.json with a passphrase-derived AES-256-GCM key.

Envelope format (version 1) — mirrored by site/crypto.js in the browser:
    {
      "v": 1,
      "kdf": "PBKDF2-SHA256",
      "iter": 200000,
      "salt": "<base64, 16 bytes>",
      "iv": "<base64, 12 bytes>",
      "ct": "<base64, ciphertext + 16-byte GCM tag>"
    }
"""

import base64
import json
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ENVELOPE_VERSION = 1
KDF_NAME = "PBKDF2-SHA256"
ITERATIONS = 200_000
SALT_BYTES = 16
IV_BYTES = 12
KEY_BYTES = 32


def _derive_key(passphrase: str, salt: bytes, iterations: int = ITERATIONS) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_BYTES,
        salt=salt,
        iterations=iterations,
    )
    return kdf.derive(passphrase.encode("utf-8"))


def encrypt_payload(plaintext: bytes, passphrase: str) -> dict:
    if not passphrase:
        raise ValueError("Passphrase must be non-empty.")
    salt = os.urandom(SALT_BYTES)
    iv = os.urandom(IV_BYTES)
    key = _derive_key(passphrase, salt)
    ct = AESGCM(key).encrypt(iv, plaintext, None)
    return {
        "v": ENVELOPE_VERSION,
        "kdf": KDF_NAME,
        "iter": ITERATIONS,
        "salt": base64.b64encode(salt).decode("ascii"),
        "iv": base64.b64encode(iv).decode("ascii"),
        "ct": base64.b64encode(ct).decode("ascii"),
    }


def decrypt_payload(envelope: dict, passphrase: str) -> bytes:
    salt = base64.b64decode(envelope["salt"])
    iv = base64.b64decode(envelope["iv"])
    ct = base64.b64decode(envelope["ct"])
    key = _derive_key(passphrase, salt, int(envelope.get("iter", ITERATIONS)))
    return AESGCM(key).decrypt(iv, ct, None)


def encrypt_file_in_place(path: str, passphrase: str) -> None:
    with open(path, "rb") as f:
        plaintext = f.read()
    envelope = encrypt_payload(plaintext, passphrase)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(envelope, f, separators=(",", ":"))

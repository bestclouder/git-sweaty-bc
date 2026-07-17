import base64
import json
import os
import sys
import tempfile
import unittest


ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPTS_DIR = os.path.join(ROOT_DIR, "scripts")
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from encrypt_data import (  # noqa: E402
    decrypt_payload,
    encrypt_file_in_place,
    encrypt_payload,
)


class EncryptDataTests(unittest.TestCase):
    def test_envelope_shape(self):
        envelope = encrypt_payload(b'{"a":1}', "hunter2")
        self.assertEqual(envelope["v"], 1)
        self.assertEqual(envelope["kdf"], "PBKDF2-SHA256")
        self.assertEqual(envelope["iter"], 200000)
        self.assertEqual(len(base64.b64decode(envelope["salt"])), 16)
        self.assertEqual(len(base64.b64decode(envelope["iv"])), 12)
        # ciphertext = plaintext length + 16-byte GCM tag
        self.assertEqual(len(base64.b64decode(envelope["ct"])), len(b'{"a":1}') + 16)

    def test_round_trip(self):
        plaintext = json.dumps({"activities": [1, 2, 3], "units": {"distance": "km"}}).encode("utf-8")
        envelope = encrypt_payload(plaintext, "correct horse battery staple")
        self.assertEqual(decrypt_payload(envelope, "correct horse battery staple"), plaintext)

    def test_wrong_passphrase_raises(self):
        envelope = encrypt_payload(b"secret", "right")
        with self.assertRaises(Exception):
            decrypt_payload(envelope, "wrong")

    def test_unique_salt_and_iv_per_call(self):
        e1 = encrypt_payload(b"same", "pw")
        e2 = encrypt_payload(b"same", "pw")
        self.assertNotEqual(e1["salt"], e2["salt"])
        self.assertNotEqual(e1["iv"], e2["iv"])
        self.assertNotEqual(e1["ct"], e2["ct"])

    def test_encrypt_file_in_place(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "data.json")
            original = {"activities": [], "years": [2026]}
            with open(path, "w", encoding="utf-8") as f:
                json.dump(original, f)
            encrypt_file_in_place(path, "pw123")
            with open(path, "r", encoding="utf-8") as f:
                envelope = json.load(f)
            self.assertIn("ct", envelope)
            self.assertNotIn("activities", envelope)
            restored = json.loads(decrypt_payload(envelope, "pw123"))
            self.assertEqual(restored, original)


if __name__ == "__main__":
    unittest.main()

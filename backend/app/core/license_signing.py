"""ECDSA P-256 signing for VSProxy license tokens.

The backend holds the private key (env ``LICENSE_SIGNING_PRIVATE_KEY``, a PEM
PKCS#8 block); the VSProxy client embeds the matching public key and verifies
every activation response. This stops a patched/fake local endpoint from
spoofing an "ok" — the client only trusts a payload the real backend signed.

Signatures are emitted in IEEE P-1363 fixed-width form (r‖s, 64 bytes) and
base64-encoded, because that is what .NET's ``ECDsa.VerifyData`` expects by
default. ``cryptography`` natively produces DER, so we transcode.
"""

from __future__ import annotations

import base64
import functools
import json
from typing import Any, Dict

from cryptography.exceptions import InvalidKey
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from ..config import settings


class LicenseSigningUnavailable(RuntimeError):
    """Raised when no signing key is configured."""


@functools.lru_cache(maxsize=1)
def _private_key() -> ec.EllipticCurvePrivateKey:
    pem = (settings.LICENSE_SIGNING_PRIVATE_KEY or "").strip()
    if not pem:
        raise LicenseSigningUnavailable(
            "LICENSE_SIGNING_PRIVATE_KEY is not set — cannot sign license tokens"
        )
    key = serialization.load_pem_private_key(pem.encode(), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        raise LicenseSigningUnavailable("LICENSE_SIGNING_PRIVATE_KEY is not an EC key")
    if key.curve.name != "secp256r1":
        raise LicenseSigningUnavailable(
            f"LICENSE_SIGNING_PRIVATE_KEY must be a P-256 key, got {key.curve.name}"
        )
    return key


def is_available() -> bool:
    try:
        _private_key()
        return True
    except (LicenseSigningUnavailable, ValueError, InvalidKey):
        return False


def canonical_payload(payload: Dict[str, Any]) -> str:
    """Deterministic JSON string the client verifies + re-parses verbatim."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def sign_payload(payload: Dict[str, Any]) -> Dict[str, str]:
    """Return ``{"payload": <canonical json>, "signature": <b64 r‖s>}``."""
    key = _private_key()
    message = canonical_payload(payload).encode()
    der = key.sign(message, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    raw = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return {
        "payload": message.decode(),
        "signature": base64.b64encode(raw).decode(),
    }


def public_key_pem() -> str:
    """SubjectPublicKeyInfo PEM to embed in the client (admin convenience)."""
    return (
        _private_key()
        .public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )

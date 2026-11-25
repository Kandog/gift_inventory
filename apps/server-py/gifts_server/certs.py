"""HTTPS certificates for the phone web app, made on this PC (no internet or paid certificate needed).

- A private certificate authority (CA), valid 20 years. Each phone installs and trusts it once.
- A server certificate signed by that CA, valid 825 days (the longest iPhones accept). It is renewed
  automatically when it gets close to expiry or when this PC's IP addresses change, so phones never
  need to install anything again as long as the CA is kept.

Files live in <data>/certs. Keep ca.key private; deleting the folder makes new ones, and then every
phone has to install the new CA.
"""
from __future__ import annotations

import ipaddress
import logging
import os
import re
import socket
from datetime import datetime, timedelta, timezone

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

CA_DAYS = 20 * 365
SERVER_DAYS = 825
RENEW_DAYS = 60
CA_NAME = 'Gift Inventory local CA'

log = logging.getLogger('gifts')


class CertFiles:
    def __init__(self, data_dir: str):
        self.dir = os.path.join(data_dir, 'certs')
        self.ca_key = os.path.join(self.dir, 'ca.key')
        self.ca_crt = os.path.join(self.dir, 'ca.crt')
        self.server_key = os.path.join(self.dir, 'server.key')
        self.server_crt = os.path.join(self.dir, 'server.crt')

    def ca_der(self) -> bytes:
        """The CA certificate in the binary form phones install."""
        with open(self.ca_crt, 'rb') as f:
            return x509.load_pem_x509_certificate(f.read()).public_bytes(serialization.Encoding.DER)


def _now():
    return datetime.now(timezone.utc)


def _new_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _write_key(path: str, key):
    with open(path, 'wb') as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))


def _write_cert(path: str, cert):
    with open(path, 'wb') as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))


def _load_cert(path: str):
    with open(path, 'rb') as f:
        return x509.load_pem_x509_certificate(f.read())


def _load_key(path: str):
    with open(path, 'rb') as f:
        return serialization.load_pem_private_key(f.read(), password=None)


def _make_ca(files: CertFiles):
    key = _new_key()
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, CA_NAME), x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'Gift Inventory')])
    now = _now()
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=CA_DAYS))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, key_cert_sign=True, crl_sign=True, content_commitment=False, key_encipherment=False,
                data_encipherment=False, key_agreement=False, encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    _write_key(files.ca_key, key)
    _write_cert(files.ca_crt, cert)
    log.info('Created a new HTTPS certificate authority in %s. Install ca.crt on each phone (see http://<this PC>:<port>/phone).', files.dir)


def _wanted_names(addresses: list[str]) -> tuple[set[str], set[str]]:
    ips = {'127.0.0.1', *addresses}
    dns = {'localhost'}
    host = socket.gethostname().lower()
    # Only valid DNS names (Windows PC names may contain "_", which certificates must not).
    if re.fullmatch(r'[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?', host):
        dns.add(host)
    return ips, dns


def _needs_new_server_cert(files: CertFiles, ips: set[str], dns: set[str]) -> bool:
    if not (os.path.exists(files.server_crt) and os.path.exists(files.server_key)):
        return True
    try:
        cert = _load_cert(files.server_crt)
        ca = _load_cert(files.ca_crt)
        if cert.issuer != ca.subject:
            return True
        if cert.not_valid_after_utc - _now() < timedelta(days=RENEW_DAYS):
            return True
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        have_ips = {str(i) for i in san.get_values_for_type(x509.IPAddress)}
        have_dns = set(san.get_values_for_type(x509.DNSName))
        return not (ips <= have_ips and dns <= have_dns)
    except Exception:  # noqa: BLE001 - unreadable files: make new ones
        return True


def _make_server_cert(files: CertFiles, ips: set[str], dns: set[str]):
    ca_key = _load_key(files.ca_key)
    ca = _load_cert(files.ca_crt)
    key = _new_key()
    now = _now()
    san = [x509.DNSName(d) for d in sorted(dns)] + [x509.IPAddress(ipaddress.ip_address(i)) for i in sorted(ips)]
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Gift Inventory server')]))
        .issuer_name(ca.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=SERVER_DAYS - 2))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, key_encipherment=True, content_commitment=False, data_encipherment=False,
                key_agreement=False, key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    _write_key(files.server_key, key)
    _write_cert(files.server_crt, cert)
    log.info('Made a new HTTPS certificate for %s (valid until %s).', ', '.join(sorted(ips | dns)), cert.not_valid_after_utc.date())


def ensure_certs(data_dir: str, addresses: list[str]) -> CertFiles:
    """Creates the CA once, and a server certificate covering this PC's current addresses."""
    files = CertFiles(data_dir)
    os.makedirs(files.dir, exist_ok=True)
    if not (os.path.exists(files.ca_crt) and os.path.exists(files.ca_key)):
        _make_ca(files)
    ips, dns = _wanted_names(addresses)
    if _needs_new_server_cert(files, ips, dns):
        _make_server_cert(files, ips, dns)
    return files

#!/usr/bin/env python3
"""
create_ipk.py  —  Build a webOS .ipk package without the full SDK.
Requires only the Python 3 standard library.

Usage:
    python create_ipk.py [app-dir] [output-dir]

Defaults:
    app-dir    = current directory  (must contain appinfo.json)
    output-dir = ./build
"""

import os, sys, io, struct, tarfile, hashlib, json, shutil, time, gzip

APP_DIR  = sys.argv[1] if len(sys.argv) > 1 else '.'
OUT_DIR  = sys.argv[2] if len(sys.argv) > 2 else os.path.join(APP_DIR, 'build')

# ── Read appinfo.json ──────────────────────────────────────────────────────────
appinfo_path = os.path.join(APP_DIR, 'appinfo.json')
if not os.path.exists(appinfo_path):
    sys.exit('ERROR: appinfo.json not found in ' + APP_DIR)

with open(appinfo_path, 'r', encoding='utf-8') as fh:
    appinfo = json.load(fh)

APP_ID      = appinfo.get('id',      'com.streamdeck.app')
APP_VERSION = appinfo.get('version', '1.0.0')
APP_DIR_INSTALL = '/usr/palm/applications/' + APP_ID

os.makedirs(OUT_DIR, exist_ok=True)

# ── Files to package ──────────────────────────────────────────────────────────
SKIP_NAMES = {
    'build', '.git', '__pycache__',
    'create_ipk.py', 'generate_icons.js',
    'build.bat', 'build.sh', 'README.md',
    'package.bat'
}
SKIP_EXTS = {'.py', '.bat', '.sh', '.ipk'}

def collect_files(base_dir):
    result = []
    for root, dirs, files in os.walk(base_dir):
        # prune skipped directories
        dirs[:] = [d for d in dirs if d not in SKIP_NAMES]
        rel_root = os.path.relpath(root, base_dir)
        for fname in files:
            if fname in SKIP_NAMES:
                continue
            _, ext = os.path.splitext(fname)
            if ext in SKIP_EXTS:
                continue
            rel_path = os.path.join(rel_root, fname) if rel_root != '.' else fname
            abs_path = os.path.join(root, fname)
            result.append((rel_path.replace('\\', '/'), abs_path))
    return result

app_files = collect_files(APP_DIR)
if not app_files:
    sys.exit('ERROR: No app files found in ' + APP_DIR)

print('Packaging ' + str(len(app_files)) + ' file(s)…')

# ── Helper: create in-memory tar.gz ───────────────────────────────────────────
def make_targz(entries):
    """
    entries: list of (arcname, bytes_or_filepath)
    Returns: bytes of the .tar.gz
    """
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz', compresslevel=9) as tar:
        for arcname, content in entries:
            if isinstance(content, (bytes, bytearray)):
                info = tarfile.TarInfo(name=arcname)
                info.size  = len(content)
                info.mtime = int(time.time())
                info.mode  = 0o644
                tar.addfile(info, io.BytesIO(content))
            else:
                # file path
                tar.add(content, arcname=arcname)
    return buf.getvalue()

# ── 1.  debian-binary ─────────────────────────────────────────────────────────
debian_binary = b'2.0\n'

# ── 2.  control.tar.gz ────────────────────────────────────────────────────────
# Calculate installed size (approximate, in KB)
installed_kb = sum(os.path.getsize(fp) for _, fp in app_files) // 1024 + 1

control_text = (
    'Package: {id}\n'
    'Version: {ver}\n'
    'Architecture: all\n'
    'Installed-Size: {size}\n'
    'Maintainer: StreamDeck\n'
    'Description: Stream Deck IPTV Application for LG webOS\n'
    'webOS-Package-Format-Version: 2\n'
    'App-Id: {id}\n'
    'App-Version: {ver}\n'
).format(id=APP_ID, ver=APP_VERSION, size=installed_kb)

control_gz = make_targz([('./control', control_text.encode('utf-8'))])

# ── 3.  data.tar.gz ───────────────────────────────────────────────────────────
data_entries = []
for rel, abs_path in app_files:
    arc = '.' + APP_DIR_INSTALL + '/' + rel
    data_entries.append((arc, abs_path))

data_gz = make_targz(data_entries)

# ── 4.  Assemble AR archive (.ipk = Debian .deb format) ──────────────────────
AR_MAGIC = b'!<arch>\n'

def ar_header(name, size):
    """Return a 60-byte AR file header."""
    name_b  = name.encode('ascii').ljust(16)[:16]
    mtime_b = str(int(time.time())).encode('ascii').ljust(12)[:12]
    uid_b   = b'0     '
    gid_b   = b'0     '
    mode_b  = b'100644  '
    size_b  = str(size).encode('ascii').ljust(10)[:10]
    magic_b = b'\x60\x0a'
    return name_b + mtime_b + uid_b + gid_b + mode_b + size_b + magic_b

def ar_entry(name, data):
    header = ar_header(name, len(data))
    # Data padded to even byte boundary
    pad    = b'\n' if len(data) % 2 else b''
    return header + data + pad

ipk_buf = (
    AR_MAGIC +
    ar_entry('debian-binary',   debian_binary) +
    ar_entry('control.tar.gz',  control_gz)    +
    ar_entry('data.tar.gz',     data_gz)
)

ipk_name = APP_ID + '_' + APP_VERSION + '_all.ipk'
ipk_path = os.path.join(OUT_DIR, ipk_name)

with open(ipk_path, 'wb') as fh:
    fh.write(ipk_buf)

size_kb = len(ipk_buf) // 1024
print()
print('IPK created:  ' + ipk_path)
print('Size:         ' + str(size_kb) + ' KB')
print()
print('Install on TV (Developer Mode must be active):')
print('  ares-install --device tv ' + ipk_path)
print('  OR copy to USB stick and install via Developer Mode app.')

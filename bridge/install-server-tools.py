"""Install verified official runtime archives into this service's own directory."""
import base64
import hashlib
import json
import os
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path('/home/ubuntu/ottbot-relay/tools')


def download(url, destination):
    request = urllib.request.Request(url, headers={'User-Agent': 'ottbot-setup/1.0'})
    with urllib.request.urlopen(request, timeout=60) as response, destination.open('wb') as out:
        while chunk := response.read(1024 * 1024):
            out.write(chunk)


def main():
    os.umask(0o077)
    ROOT.mkdir(parents=True, exist_ok=True)
    node_version = 'v24.22.2'
    node_name = f'node-{node_version}-linux-x64'
    node_dir = ROOT / node_name
    if not (node_dir / 'bin/node').exists():
        archive = ROOT / (node_name + '.tar.xz')
        base = f'https://nodejs.org/dist/{node_version}/'
        download(base + archive.name, archive)
        with urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=30) as response:
            rows = response.read().decode().splitlines()
        checksum = next(row.split()[0] for row in rows if row.split()[-1] == archive.name)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
            raise ValueError('Node.js checksum mismatch')
        with tarfile.open(archive) as tar:
            tar.extractall(ROOT, filter='data')
        print('Node.js archive verified and installed.', flush=True)
    version = '0.165.0'
    codex_dir = ROOT / ('codex-' + version)
    marker = codex_dir / '.verified'
    if not marker.exists():
        with urllib.request.urlopen(f'https://registry.npmjs.org/@openai/codex/{version}-linux-x64', timeout=30) as response:
            meta = json.load(response)
        archive = ROOT / ('codex-' + version + '-linux-x64.tgz')
        download(meta['dist']['tarball'], archive)
        digest = hashlib.sha512(archive.read_bytes()).digest()
        if 'sha512-' + base64.b64encode(digest).decode() != meta['dist']['integrity']:
            raise ValueError('Codex package integrity mismatch')
        codex_dir.mkdir(exist_ok=True)
        with tarfile.open(archive) as tar:
            tar.extractall(codex_dir, filter='data')
        marker.write_text('npm integrity verified\n')
        print('Official Codex archive verified and installed.', flush=True)
    binaries = [p for p in codex_dir.rglob('codex') if p.is_file() and p.parent.name in ('bin', 'codex')]
    if len(binaries) != 1:
        raise RuntimeError('Expected one native Codex binary')
    os.chmod(binaries[0], 0o700)
    paths = {'node': str(node_dir / 'bin/node'), 'codex': str(binaries[0])}
    (ROOT / 'paths.json').write_text(json.dumps(paths, indent=2))
    print(json.dumps(paths), flush=True)


if __name__ == '__main__':
    main()

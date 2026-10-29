"""Prepare private hybrid service configuration without copying desktop credentials."""
import json
import os
from pathlib import Path

root = Path('/home/ubuntu/ottbot-relay')
shared = root / 'shared'
os.umask(0o077)
relay = json.loads((shared / 'relay.json').read_text())
paths = json.loads((root / 'tools/paths.json').read_text())
settings = {
    'server-worker.json': {
        'codexPath': paths['codex'], 'workspace': '/home/ubuntu/ottlog/current',
        'port': 18891, 'workerToken': relay['workerToken'],
        'defaultModel': 'gpt-6.1-sol', 'timeoutMs': 600000,
        'sandbox': 'read-only', 'skipGitCheck': True,
        'reportAuthentication': True, 'executionName': 'server-codex',
    },
    'hub.json': {
        'port': 18892, 'workerToken': relay['workerToken'],
        'serverWorkerUrl': 'http://127.0.0.1:18891',
        'computerWorkerUrl': 'http://127.0.0.1:18450',
    },
    'weixin.json': {
        'hubUrl': 'http://127.0.0.1:18892', 'workerToken': relay['workerToken'],
    },
}
for name, config in settings.items():
    path = shared / name
    if path.exists():
        if json.loads(path.read_text()) != config:
            raise RuntimeError(f'{name} already exists with different settings; no overwrite')
    else:
        with path.open('x') as handle:
            json.dump(config, handle, indent=2)
        os.chmod(path, 0o600)
print('Hybrid configuration prepared; credentials were not printed.')

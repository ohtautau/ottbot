"""Deploy a tested GitHub checkout; private state stays outside the repository."""
import argparse
import datetime
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path('/home/ubuntu/ottbot-relay')
SOURCE = Path(__file__).resolve().parent.parent


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def private_json(path, value):
    if path.exists():
        return json.loads(path.read_text())
    with path.open('x') as handle:
        json.dump(value, handle, indent=2)
    path.chmod(0o600)
    return value


def link(path, target):
    next_path = path.with_name(path.name + '.next')
    next_path.unlink(missing_ok=True)
    next_path.symlink_to(target, target_is_directory=True)
    next_path.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=Path.home() / 'ottbot-workspace')
    parser.add_argument('--start-weixin', action='store_true')
    args = parser.parse_args()
    if Path.home() != Path('/home/ubuntu'):
        raise RuntimeError('Run as the ubuntu deployment account, not root.')
    os.umask(0o077)
    revision = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
    origin = subprocess.check_output(['git', '-C', str(SOURCE), 'remote', 'get-url', 'origin'], text=True).strip()
    if origin not in ['https://github.com/ohtautau/ottbot.git', 'git@github.com:ohtautau/ottbot.git']:
        raise RuntimeError('Unexpected source repository.')
    if subprocess.check_output(['git', '-C', str(SOURCE), 'status', '--porcelain'], text=True).strip():
        raise RuntimeError('Deployment checkout has local changes; commit and synchronize through GitHub first.')
    shared = ROOT / 'shared'
    shared.mkdir(parents=True, exist_ok=True)
    shared.chmod(0o700)
    args.workspace.mkdir(parents=True, exist_ok=True)
    run(sys.executable, str(SOURCE / 'bridge/install-server-tools.py'))
    paths = json.loads((ROOT / 'tools/paths.json').read_text())
    release = ROOT / 'releases' / revision
    if not release.exists():
        release.mkdir(parents=True)
        archive = subprocess.Popen(['git', '-C', str(SOURCE), 'archive', revision], stdout=subprocess.PIPE)
        try:
            with tarfile.open(fileobj=archive.stdout, mode='r|') as tar:
                tar.extractall(release, filter='data')
        finally:
            archive.stdout.close()
        if archive.wait() != 0:
            raise RuntimeError('Git archive failed; services were not switched.')
    bridge = release / 'bridge'
    for name in ['worker.mjs', 'hub.mjs', 'weixin.mjs', 'models.mjs', 'reasoning.mjs', 'api-setup.mjs']:
        run(paths['node'], '--check', str(bridge / name))
    run(paths['node'], '--test', *(str(bridge / name) for name in ['worker.test.mjs', 'hub.test.mjs', 'weixin.test.mjs', 'models.test.mjs', 'api-setup.test.mjs']))
    private_json(shared / 'providers.json', json.loads((bridge / 'providers.example.json').read_text()))
    relay = private_json(shared / 'relay.json', {
        'clientToken': secrets.token_hex(32), 'workerToken': secrets.token_hex(32),
        'port': 8089, 'workerPort': 18892,
    })
    if any(not isinstance(relay.get(k), str) or len(relay[k]) < 32 for k in ['clientToken', 'workerToken']):
        raise RuntimeError('Invalid private relay configuration.')
    configs = {
        'server-worker.json': {
            'codexPath': paths['codex'], 'workspace': str(args.workspace.resolve()),
            'port': 18891, 'workerToken': relay['workerToken'], 'defaultModel': 'gpt-6.1-sol',
            'timeoutMs': 600000, 'sandbox': 'read-only', 'skipGitCheck': True,
            'reportAuthentication': True, 'executionName': 'server-codex',
            'providersFile': str(shared / 'providers.json'),
        },
        'hub.json': {
            'port': 18892, 'workerToken': relay['workerToken'],
            'serverWorkerUrl': 'http://127.0.0.1:18891', 'computerWorkerUrl': 'http://127.0.0.1:18450',
            'providersFile': str(shared / 'providers.json'),
        },
        'weixin.json': {'hubUrl': 'http://127.0.0.1:18892', 'workerToken': relay['workerToken']},
    }
    for name, value in configs.items():
        saved = private_json(shared / name, value)
        if saved.get('workerToken') != relay['workerToken']:
            raise RuntimeError(f'{name} has a different private token; no switch was made.')
    units = Path.home() / '.config/systemd/user'
    units.mkdir(parents=True, exist_ok=True)
    for name in ['ottbot-relay', 'ottbot-codex', 'ottbot-hub', 'ottbot-weixin']:
        (units / (name + '.service')).write_text((bridge / (name + '.service')).read_text())
    link(ROOT / 'current', bridge)
    link(ROOT / 'hybrid-current', bridge)
    run('sudo', '-n', 'loginctl', 'enable-linger', 'ubuntu')
    run('systemctl', '--user', 'daemon-reload')
    for name in ['ottbot-codex', 'ottbot-hub', 'ottbot-relay']:
        run('systemctl', '--user', 'enable', name + '.service')
        run('systemctl', '--user', 'restart', name + '.service')
    run('systemctl', '--user', 'enable', 'ottbot-weixin.service')
    if args.start_weixin:
        if not (shared / 'weixin-account.json').exists():
            raise RuntimeError('Weixin account not paired; receiver was not started.')
        run('systemctl', '--user', 'restart', 'ottbot-weixin.service')
    deployment = {'revision': revision, 'repository': origin, 'release': str(release),
                  'deployedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (shared / 'deployment.json').write_text(json.dumps(deployment, indent=2))
    print('GitHub revision deployed:', revision)
    print('Credentials remain in private shared/; no public model port opened.')


if __name__ == '__main__':
    main()

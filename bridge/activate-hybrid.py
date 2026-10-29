"""Switch the legacy proxy only after the always-on server route actually works."""
import json
import os
from pathlib import Path
import subprocess
import urllib.request

ROOT = Path('/home/ubuntu/ottbot-relay')
SHARED = ROOT / 'shared'


def main():
    os.umask(0o077)
    relay = json.loads((SHARED / 'relay.json').read_text())
    if not (SHARED / 'weixin-account.json').exists():
        raise RuntimeError('Weixin pairing has not completed; no switch was made.')
    headers = {'Authorization': 'Bearer ' + relay['workerToken'], 'Content-Type': 'application/json'}

    def request(path, body=None):
        raw = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request('http://127.0.0.1:18892' + path, data=raw, headers=headers)
        with urllib.request.urlopen(req, timeout=180) as response:
            return json.load(response)

    health = request('/health')
    if not health.get('serverAuthenticated'):
        raise RuntimeError('Server Codex is not signed in with ChatGPT; no switch was made.')
    result = request('/v1/chat/completions', {'model': 'codex-local', 'messages': [
        {'role': 'user', 'content': '/服务器 只回复“服务器独立执行成功”，不要读取文件、执行命令或调用工具。'}
    ]})
    answer = result.get('choices', [{}])[0].get('message', {}).get('content', '')
    if '服务器独立执行成功' not in answer:
        raise RuntimeError('Server inference did not pass; no switch was made.')
    backup = SHARED / 'relay.before-hybrid.json'
    if not backup.exists():
        with backup.open('x') as handle:
            json.dump(relay, handle)
    relay['workerPort'] = 18892
    temp = SHARED / 'relay.json.next'
    temp.write_text(json.dumps(relay, indent=2))
    os.replace(temp, SHARED / 'relay.json')
    subprocess.run(['systemctl', '--user', 'restart', 'ottbot-relay.service', 'ottbot-weixin.service'], check=True)
    print('Hybrid server inference verified; legacy proxy switched and Weixin receiver started.')


if __name__ == '__main__':
    main()

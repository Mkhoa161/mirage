# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
"""Live daemon stdin and large grep output, on both hosts and RAM/disk.

Run from the repository root after building TypeScript packages:
    ./python/.venv/bin/python integ/execute_stdin.py

Uses HTTP directly: grep returns its full output, the caller sends those
bytes back as stdin to save a file, and the saved hash must match. Covers
output above 1 MiB and output below 1 MiB whose base64 exceeds that limit.
Each daemon has a private home and port and is terminated in finally.
"""
import base64
import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
MIB = 1024 * 1024


@contextmanager
def daemon(host: str, root: Path):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = {
        **os.environ,
        'MIRAGE_HOME': str(root / 'home'),
        'MIRAGE_DAEMON_PORT': str(port),
        'MIRAGE_AUTH_MODE': 'token',
        'MIRAGE_AUTH_TOKEN': 'stdin-integ',
        'MIRAGE_IDLE_GRACE_SECONDS': '600',
    }
    command = ([
        sys.executable, '-m', 'uvicorn', 'mirage.server.daemon:app', '--host',
        '127.0.0.1', '--port',
        str(port)
    ] if host == 'python' else [
        'node',
        str(ROOT / 'typescript/packages/server/dist/bin/daemon.js')
    ])
    with (root / 'daemon.log').open('w+') as log:
        process = subprocess.Popen(command,
                                   cwd=ROOT,
                                   env=env,
                                   stdout=log,
                                   stderr=log)
        try:
            with httpx.Client(base_url=f'http://127.0.0.1:{port}',
                              headers={'Authorization': 'Bearer stdin-integ'},
                              timeout=60) as client:
                deadline = time.monotonic() + 30
                ready = False
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        break
                    try:
                        if client.get('/v1/workspaces',
                                      timeout=1).status_code == 200:
                            ready = True
                            break
                    except httpx.TransportError:
                        pass
                    time.sleep(0.05)
                if not ready:
                    log.seek(0)
                    raise RuntimeError(
                        f'{host} daemon did not start:\n{log.read()}')
                yield client
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def execute(client: httpx.Client,
            wid: str,
            command: str,
            stdin: bytes | None = None,
            background: bool = False,
            legacy: bool = False) -> dict:
    body = {'command': command, 'record': False}
    kwargs = {'json': body}
    if stdin is not None:
        if legacy:
            body['stdinBase64'] = base64.b64encode(stdin).decode()
        else:
            kwargs = {
                'files': {
                    'request':
                    ('request.json', json.dumps(body), 'application/json'),
                    'stdin': ('stdin.bin', stdin, 'application/octet-stream'),
                }
            }
    response = client.post(f'/v1/workspaces/{wid}/execute',
                           params={'background': str(background).lower()},
                           **kwargs)
    response.raise_for_status()
    result = response.json()
    if background:
        job_id = result.get('job_id', result.get('jobId'))
        response = client.post(f'/v1/jobs/{job_id}/wait',
                               json={'timeoutS': 60})
        response.raise_for_status()
        job = response.json()
        assert job['status'] == 'done', job
        result = job['result']
    assert result.get('exit_code', result.get('exitCode')) == 0, result
    assert not result['stderr'], result['stderr']
    return result


def check_workspace(client: httpx.Client, host: str, vfs: str,
                    root: Path) -> None:
    mount = {'vfs': vfs}
    if vfs == 'disk':
        mount['config'] = {'root': str(root)}
    created = client.post('/v1/workspaces',
                          json={
                              'config': {
                                  'mode': 'EXEC',
                                  'mounts': {
                                      '/work': mount
                                  }
                              },
                          })
    created.raise_for_status()
    wid = created.json()['id']
    try:
        if host == 'typescript':
            for legacy in (False, True):
                for stdin in (b'', b'\x00\xff\r\n' + 'α'.encode()):
                    result = execute(client,
                                     wid, 'python3 -c "import sys; '
                                     'print(sys.stdin.buffer.read().hex())"',
                                     stdin,
                                     legacy=legacy)
                    assert result['stdout'] == stdin.hex() + '\n', result
            print(
                f'{host}/{vfs}: Python stdin '
                '(empty/binary, JSON/multipart) OK',
                flush=True)
        for background in (False, True):
            for count in (400_000, 600_000):
                expected = 'needle ' + 'α' * count + '\n'
                source = ('unmatched\n' + expected).encode()
                byte_count = len(expected.encode())
                assert len(base64.b64encode(expected.encode())) > MIB
                assert (byte_count > MIB) == (count == 600_000)
                execute(client, wid, 'cat > /work/source.txt', source,
                        background)
                result = execute(client,
                                 wid,
                                 'grep needle /work/source.txt',
                                 background=background)
                assert result['stdout'] == expected
                data = result['stdout'].encode()
                if host == 'typescript':
                    # Base64 JSON still fails at its intended limit.
                    refused = client.post(f'/v1/workspaces/{wid}/execute',
                                          json={
                                              'command':
                                              'cat > /work/saved.txt',
                                              'stdinBase64':
                                              base64.b64encode(data).decode(),
                                          })
                    assert refused.status_code == 413, refused.text[:200]
                execute(client, wid, 'cat > /work/saved.txt', data, background)
                saved = execute(client, wid, 'sha256sum /work/saved.txt')
                assert saved['stdout'].split()[0] == hashlib.sha256(
                    data).hexdigest()
                piped = execute(client, wid, 'grep needle', source, background)
                assert piped['stdout'] == expected
                print(
                    f'{host}/{vfs}/background={background}: '
                    f'grep + save + SHA256, {len(data)} bytes OK',
                    flush=True)
    finally:
        deleted = client.delete(f'/v1/workspaces/{wid}')
        deleted.raise_for_status()


def main() -> None:
    for host in ('python', 'typescript'):
        with tempfile.TemporaryDirectory(
                prefix=f'mirage-stdin-{host}-') as temporary:
            root = Path(temporary)
            with daemon(host, root) as client:
                for vfs in ('ram', 'disk'):
                    files = root / vfs
                    files.mkdir()
                    check_workspace(client, host, vfs, files)
    print('Live daemon stdin and grep round trips passed on both hosts.')


if __name__ == '__main__':
    main()

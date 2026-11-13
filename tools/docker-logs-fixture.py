"""Opt-in local WSL/OpenSSH/Docker fixture; never touches existing containers/config."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=30).stdout.strip()


def processes(scope):
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / 'cmdline').read_bytes().split(b'\0')
            if b'logs' in args and any(value and value.encode() in args for value in (scope['container'], scope['project'])):
                found.append(int(entry.name))
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
    return found


def setup(qa):
    qa.mkdir(parents=True, exist_ok=True)
    config = qa / 'fixture.json'
    if config.exists():
        raise RuntimeError('Existing fixture must be cleaned before setup')
    # OpenSSH StrictModes checks all parents; /tmp is intentionally world writable.
    root = Path(tempfile.mkdtemp(prefix='serverdeck-log-qa-', dir='/run'))
    project = 'sdlogqa' + uuid.uuid4().hex
    scope = {'root': str(root), 'project': project, 'container': '', 'sshdPid': None}
    config.write_text(json.dumps(scope))
    for name in ('host-key', 'client-key'):
        run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(root / name))
    # Only ephemeral test keys; no existing authorized_keys or credentials are read/changed.
    (qa / 'client-key').write_bytes((root / 'client-key').read_bytes())
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    ssh_config = root / 'sshd_config'
    ssh_config.write_text(f'''Port {port}
ListenAddress 127.0.0.1
HostKey {root}/host-key
AuthorizedKeysFile {root}/client-key.pub
PidFile {root}/sshd.pid
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
PermitRootLogin prohibit-password
AllowUsers root
StrictModes yes
LogLevel VERBOSE
''')
    run('/usr/sbin/sshd', '-t', '-f', str(ssh_config))
    with (root / 'sshd.log').open('wb') as output:
        server = subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', str(ssh_config)],
                                  stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                  start_new_session=True)
    scope.update(sshdPid=server.pid, port=port, username='root', hostname='127.0.0.1',
                 publicKey=' '.join((root / 'host-key.pub').read_text().split()[:2]),
                 fingerprint=run('ssh-keygen', '-lf', str(root / 'host-key.pub')).split()[1])
    config.write_text(json.dumps(scope))
    # Existing local image only: no pull, no volumes, no published ports, unique project/label.
    image = os.environ.get('SERVERDECK_LOG_QA_IMAGE', 'nginx:1.14.2')
    run('docker', 'image', 'inspect', image)
    compose = {'services': {'logs': {
        'image': image, 'pull_policy': 'never', 'network_mode': 'none',
        'entrypoint': ['/bin/sh', '-c'],
        'command': ['while :; do echo SERVERDECK_LOG_QA; sleep 1; done'],
        'read_only': True, 'cap_drop': ['ALL'], 'mem_limit': '64m', 'pids_limit': 32,
        'labels': {'cn.hiboot.log-qa': project},
    }}}
    (root / 'compose.yaml').write_text(json.dumps(compose))
    run('docker', 'compose', '-p', project, '-f', str(root / 'compose.yaml'), 'up', '-d', '--no-build', '--pull', 'never')
    scope['container'] = run('docker', 'compose', '-p', project, '-f', str(root / 'compose.yaml'), 'ps', '-q')
    config.write_text(json.dumps(scope))
    print(json.dumps({'ready': True, 'port': port, 'container': scope['container']}))


def cleanup(qa, scope):
    root = Path(scope['root'])
    assert root.parent == Path('/run') and root.name.startswith('serverdeck-log-qa-')
    assert root.resolve() == root and not root.is_symlink()
    containers = run('docker', 'container', 'ls', '--all', '--quiet', '--no-trunc',
                     '--filter', 'label=cn.hiboot.log-qa=' + scope['project']).split()
    for container in containers:
        assert run('docker', 'inspect', '--format', '{{index .Config.Labels "cn.hiboot.log-qa"}}', container) == scope['project']
    if (root / 'compose.yaml').exists():
        run('docker', 'compose', '-p', scope['project'], '-f', str(root / 'compose.yaml'), 'down', '--timeout', '2')
    else:
        assert not containers, 'Missing fixture configuration; retain containers for diagnosis'
    assert not processes(scope), 'Log client processes remain; retain fixture for diagnosis'
    pid = scope['sshdPid']
    if pid and Path(f'/proc/{pid}/cmdline').exists():
        args = Path(f'/proc/{pid}/cmdline').read_bytes()
        assert str(root / 'sshd_config').encode() in args, 'SSHD PID no longer belongs to fixture'
        os.kill(pid, signal.SIGTERM)
    if root.exists():
        allowed = {'host-key', 'host-key.pub', 'client-key', 'client-key.pub',
                   'sshd_config', 'sshd.log', 'sshd.pid', 'compose.yaml'}
        for child in root.iterdir():
            if not child.exists():
                continue  # sshd removes its PID file on exit.
            assert child.name in allowed and child.is_file() and not child.is_symlink()
            child.unlink()
        root.rmdir()
    (qa / 'client-key').unlink(missing_ok=True)
    (qa / 'fixture.json').unlink()
    print(json.dumps({'cleaned': True}))


if __name__ == '__main__':
    mode, directory = sys.argv[1:]
    qa = Path(directory).resolve()
    if mode == 'setup':
        setup(qa)
    else:
        scope = json.loads((qa / 'fixture.json').read_text())
        if mode == 'status':
            print(json.dumps({'processes': processes(scope)}))
        elif mode == 'cleanup':
            cleanup(qa, scope)
        else:
            raise ValueError('Unknown fixture mode')

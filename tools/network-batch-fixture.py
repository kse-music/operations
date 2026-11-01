"""Test-only isolated Linux SSH containers. Invoked through an already trusted SSH shell.

No production server configuration or existing Docker object is modified. No image pull.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tarfile
import tempfile
import time


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, timeout=kwargs.pop('timeout', 30), **kwargs)
    if result.returncode:
        raise RuntimeError(str(args[0]) + ': ' + result.stderr.decode(errors='replace')[:1500])
    return result.stdout.decode().strip()


uid = os.getuid()
sock = '/run/user/%s/docker.sock' % uid
if not os.path.exists(sock):
    sock = '/var/run/docker.sock'
d = ['docker', '--host', 'unix://' + sock]
label = 'io.serverdeck.network-e2e'
uuid = data['uuid']
if not re.fullmatch(r'[a-f0-9-]{36}', uuid):
    raise ValueError('invalid scope')


def save():
    (root / 'scope.json').write_text(json.dumps(scope))


def cleanup():
    matches = list(Path(tempfile.gettempdir()).glob('serverdeck-network-e2e-' + uuid + '-*'))
    if not matches:
        return {'cleaned': True}
    if len(matches) != 1:
        raise ValueError('ambiguous owned scope')
    candidate = matches[0]
    if candidate.is_symlink() or candidate.resolve().parent != Path(tempfile.gettempdir()).resolve():
        raise ValueError('unsafe cleanup root')
    record = json.loads((candidate / 'scope.json').read_text())
    if record['uuid'] != uuid:
        raise ValueError('scope ownership mismatch')
    for cid in record.get('containers', []):
        result = subprocess.run(d + ['inspect', cid], capture_output=True)
        if result.returncode:
            continue
        info = json.loads(result.stdout)[0]
        if info['Config']['Labels'].get(label) != uuid:
            raise ValueError('container ownership mismatch')
        run(d + ['stop', '--time', '2', cid])
        run(d + ['rm', cid])
    if record.get('image'):
        result = subprocess.run(d + ['image', 'inspect', record['image']], capture_output=True)
        if result.returncode == 0:
            info = json.loads(result.stdout)[0]
            if info['Config']['Labels'].get(label) != uuid:
                raise ValueError('image ownership mismatch')
            run(d + ['image', 'rm', record['image']])
    # This verified, UUID-owned directory contains only generated copies/keys/tar.
    # rmtree does not traverse the copied /bin/sh symlink.
    shutil.rmtree(candidate)
    return {'cleaned': True}


if mode == 'cleanup':
    result = cleanup()
elif mode == 'create':
    public = data['publicKey'].strip()
    if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?', public):
        raise ValueError('only generated Ed25519 test public key accepted')
    root = Path(tempfile.mkdtemp(prefix='serverdeck-network-e2e-' + uuid + '-'))
    scope = {'uuid': uuid, 'containers': [], 'image': None}
    save()
    fs = root / 'fs'
    for directory in ['usr/sbin', 'usr/bin', 'bin', 'etc', 'root/.ssh', 'run/sshd', 'tmp', 'data', 'dev', 'proc', 'keys']:
        (fs / directory).mkdir(parents=True, exist_ok=True)
    (fs / 'tmp').chmod(0o1777)
    (fs / 'root').chmod(0o700)
    (fs / 'root/.ssh').chmod(0o700)
    (fs / 'root/.ssh/authorized_keys').write_text(public + '\n')
    (fs / 'root/.ssh/authorized_keys').chmod(0o600)

    def copy_binary(path):
        path = Path(path)
        if not path.is_file():
            raise ValueError('required host binary missing: ' + str(path))
        target = fs / str(path).lstrip('/')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target, follow_symlinks=True)
        libraries = run(['ldd', str(path)])
        for dependency in re.findall(r'(?:=>\s+|^\s*)(/[^\s]+)', libraries, re.M):
            destination = fs / dependency.lstrip('/')
            if not destination.exists():
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dependency, destination)
            # This Ubuntu x64 fixture has no host ld.so cache/custom library paths.
            # Also place resolved dependencies in the loader's standard multiarch directory.
            if os.uname().machine != 'x86_64':
                raise ValueError('this isolated fixture currently supports Ubuntu x64')
            standard = fs / 'lib/x86_64-linux-gnu' / Path(dependency).name
            standard.parent.mkdir(parents=True, exist_ok=True)
            if not standard.exists():
                shutil.copy2(dependency, standard)

    for executable in ['/usr/sbin/sshd', '/usr/bin/dash', '/usr/bin/bash', '/usr/bin/sleep', '/usr/bin/hostname', '/usr/bin/sha256sum', '/usr/bin/mkdir', '/usr/bin/cat', '/usr/bin/wc', '/usr/bin/dd', '/usr/bin/rm', '/usr/bin/ls', '/usr/bin/env', '/usr/bin/printf']:
        copy_binary(executable)
    if data.get('python'):
        copy_binary('/usr/bin/python3')
        version = run(['/usr/bin/python3', '-c', 'import sys;print(str(sys.version_info.major)+"."+str(sys.version_info.minor))'])
        stdlib = Path('/usr/lib/python' + version)
        if not stdlib.is_dir():
            raise ValueError('system Python standard library missing')
        shutil.copytree(stdlib, fs / 'usr/lib' / stdlib.name, ignore=shutil.ignore_patterns('__pycache__', 'test', 'tests', 'idlelib', 'tkinter', 'ensurepip', 'venv', 'site-packages', 'dist-packages'), dirs_exist_ok=True)
    (fs / 'bin/sh').symlink_to('../usr/bin/dash')
    (fs / 'bin/bash').symlink_to('../usr/bin/bash')
    (fs / 'etc/passwd').write_text('root:x:0:0:test:/root:/bin/sh\nsshd:x:65534:65534:sshd:/run/sshd:/usr/sbin/nologin\n')
    (fs / 'etc/group').write_text('root:x:0:\nsshd:x:65534:\n')
    password_hash = run(['openssl', 'passwd', '-6', '-stdin'], input=secrets.token_bytes(32).hex().encode())
    (fs / 'etc/shadow').write_text('root:' + password_hash + ':19000:0:99999:7:::\nsshd:!:19000:0:99999:7:::\n')
    (fs / 'etc/shadow').chmod(0o600)
    (fs / 'etc/nsswitch.conf').write_text('passwd: files\ngroup: files\nshadow: files\nhosts: files dns\n')
    (fs / 'etc/sshd_config').write_text('Port 22\nListenAddress 0.0.0.0\nHostKey /keys/host_key\nPidFile /run/sshd.pid\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nUseDNS no\nAuthorizedKeysFile /root/.ssh/authorized_keys\nAuthenticationMethods publickey\nAllowTcpForwarding no\nAllowAgentForwarding no\nX11Forwarding no\nPermitTunnel no\nMaxSessions 16\nLogLevel ERROR\nSubsystem sftp internal-sftp\n')
    archive = root / 'rootfs.tar'
    def owner(info):
        info.uid = info.gid = 0
        info.uname = info.gname = 'root'
        if info.isdir():
            info.mode = 0o700 if info.name in ('root', 'root/.ssh') else (0o1777 if info.name == 'tmp' else 0o755)
        else:
            info.mode &= ~0o022
        return info
    with tarfile.open(archive, 'w') as tar:
        for child in fs.iterdir():
            tar.add(child, arcname=child.name, filter=owner)
    scope['image'] = run(d + ['import', '--change', 'LABEL ' + label + '=' + uuid, str(archive), 'serverdeck-network-e2e:' + uuid], timeout=60)
    save()
    servers = []
    for index in range(2):
        keys = root / ('key-' + str(index))
        keys.mkdir(mode=0o700)
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(keys / 'host_key')])
        fingerprint = run(['ssh-keygen', '-lf', str(keys / 'host_key.pub'), '-E', 'sha256']).split()[1]
        hostname = 'sd-' + str(index) + '-' + uuid[:8]
        cid = run(d + ['create', '--name', 'serverdeck-network-' + uuid + '-' + str(index), '--label', label + '=' + uuid, '--hostname', hostname, '--memory', '128m', '--cpus', '0.5', '--pids-limit', '64', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'SYS_CHROOT', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges', '--publish', '127.0.0.1::22', '--mount', 'type=bind,src=' + str(keys) + ',dst=/keys,readonly', scope['image'], '/usr/sbin/sshd', '-D', '-e', '-f', '/etc/sshd_config'])
        scope['containers'].append(cid)
        save()
        run(d + ['start', cid])
        time.sleep(0.3)
        info = json.loads(run(d + ['inspect', cid]))[0]
        if not info['State']['Running']:
            logs = subprocess.run(d + ['logs', cid], capture_output=True)
            raise RuntimeError(json.dumps(info['State']) + '\n' + (logs.stdout + logs.stderr).decode(errors='replace')[:3000])
        port = int(info['NetworkSettings']['Ports']['22/tcp'][0]['HostPort'])
        servers.append({'containerId': cid, 'port': port, 'hostname': hostname, 'fingerprint': fingerprint})
    result = {'uuid': uuid, 'servers': servers}
else:
    raise ValueError('unknown fixture mode')
print('__SD_OP'+'S_REF__' + base64.b64encode(json.dumps(result).encode()).decode() + '__SD_OP'+'S_END__')

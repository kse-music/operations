// Owned WSL SSH endpoint and Linux resources for real plugin-component tests.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = fileURLToPath(new URL('../', import.meta.url));
const uuid = randomUUID();
const directory = path.join(root, '.local/plugin-components', uuid);
const distro = process.env.SERVERDECK_PLUGIN_TEST_DISTRO ?? 'Ubuntu-24.04';
await mkdir(directory, { recursive: true });
const key = path.join(directory, 'client-key');
function run(command, args, input) {
  const result = spawnSync(command, args, {
    cwd: root,
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr.slice(-2000)}`);
  return result.stdout.trim();
}
const linux = (source) =>
  run('wsl.exe', ['--distribution', distro, '--exec', 'python3', '-'], source);
const fixtureSource = await readFile(path.join(root, 'tools/ops-fixture.py'), 'utf8');
function fixture(mode, data) {
  const output = linux(
    `import json\nmode=${JSON.stringify(mode)}\ndata=json.loads(${JSON.stringify(JSON.stringify(data))})\n` +
      fixtureSource,
  );
  const match = /__SD_OPS_REF__(.*?)__SD_OPS_END__/.exec(output);
  assert(match, 'owned fixture did not return its result');
  const result = JSON.parse(Buffer.from(match[1], 'base64').toString());
  assert(!result.error, `owned fixture failed: ${result.error}`);
  return result;
}
let endpoint, resources, failure, keeperPid;
const keeper = spawn(
  'wsl.exe',
  [
    '--distribution',
    distro,
    '--exec',
    'python3',
    '-u',
    '-c',
    'import os,time; print(os.getpid(),flush=True); time.sleep(3600)',
    uuid,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
);
try {
  keeperPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('owned WSL keeper did not start')), 20000);
    keeper.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    keeper.stdout.once('data', (data) => {
      clearTimeout(timer);
      const value = Number(data.toString().trim());
      assert(Number.isInteger(value) && value > 1);
      resolve(value);
    });
  });
  run('ssh-keygen.exe', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const publicKey = (await readFile(`${key}.pub`, 'utf8')).trim();
  endpoint = JSON.parse(
    linux(`import json,os,pathlib,tempfile,subprocess,socket,ipaddress
data=json.loads(${JSON.stringify(JSON.stringify({ uuid, publicKey }))})
root=pathlib.Path(tempfile.mkdtemp(prefix='serverdeck-plugin-components-'+data['uuid']+'-',dir='/run/user/0'))
assert root.parent==pathlib.Path('/run/user/0') and root.resolve()==root and not root.is_symlink()
(root/'authorized_keys').write_text(data['publicKey']+'\\n');os.chmod(root/'authorized_keys',0o600)
subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(root/'host-key')],check=True)
s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close()
addresses=['127.0.0.1']
config='Port '+str(port)+'\\n'+''.join('ListenAddress '+a+'\\n' for a in addresses)+'''HostKey {root}/host-key
PidFile {root}/sshd.pid
AuthorizedKeysFile {root}/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
AllowUsers root
UsePAM yes
StrictModes yes
Subsystem sftp internal-sftp
SetEnv XDG_RUNTIME_DIR=/run/user/0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus
LogLevel VERBOSE
'''.format(root=root)
(root/'sshd_config').write_text(config)
subprocess.run(['/usr/sbin/sshd','-t','-f',str(root/'sshd_config')],check=True)
with open(root/'sshd.log','w') as log:
    child=subprocess.Popen(['/usr/sbin/sshd','-D','-e','-f',str(root/'sshd_config')],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
stat=pathlib.Path('/proc/'+str(child.pid)+'/stat').read_text();start=stat[stat.rfind(')')+2:].split()[19]
print(json.dumps(dict(root=str(root),pid=child.pid,start=start,port=port,addresses=addresses,publicKey=(root/'host-key.pub').read_text().strip())))
`),
  );
  await writeFile(path.join(directory, 'endpoint.json'), JSON.stringify(endpoint, null, 2));
  resources = { uuid };
  resources = fixture('create', resources);
  linux(`import subprocess
subprocess.run(['docker','start',${JSON.stringify(resources.container)}],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['systemctl','--user','start',${JSON.stringify(resources.unit)}],check=True)
`);
  let host;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let retry = 0; retry < 30 && !host; retry++) {
    for (const address of endpoint.addresses) {
      const reachable = await new Promise((resolve) => {
        const socket = net.createConnection({ host: address, port: endpoint.port });
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(700, () => finish(false));
        socket.on('data', (data) => finish(data.toString().startsWith('SSH-2.0-')));
        socket.on('error', () => finish(false));
      });
      if (reachable) {
        host = address;
        break;
      }
    }
    if (!host) await delay(250);
  }
  assert(host, 'owned WSL SSH endpoint is not reachable from Windows');
  const file = path.join(directory, 'fixture.json');
  await writeFile(
    file,
    JSON.stringify(
      {
        uuid,
        host,
        port: endpoint.port,
        username: 'root',
        keyPath: key,
        publicKey: endpoint.publicKey,
        resources,
      },
      null,
      2,
    ),
  );
  const args = [path.join(root, 'tools/plugin-ui-isolation-e2e.mjs')];
  if (process.env.SERVERDECK_COMPONENT_REUSE)
    args.push('--reuse', process.env.SERVERDECK_COMPONENT_REUSE);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, SERVERDECK_PLUGIN_COMPONENT_FIXTURE: file },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'native component checks failed');
} catch (error) {
  failure = error;
} finally {
  const failures = [];
  if (resources)
    try {
      fixture('cleanup', resources);
    } catch (error) {
      failures.push(error);
    }
  if (endpoint)
    try {
      const log = linux(
        `import pathlib\nroot=pathlib.Path(${JSON.stringify(endpoint.root)})\nassert root.parent==pathlib.Path('/run/user/0') and root.name.startswith('serverdeck-plugin-components-${uuid}-') and not root.is_symlink()\nprint((root/'sshd.log').read_text())\n`,
      );
      await writeFile(path.join(directory, 'sshd.log'), log);
      linux(`import json,os,pathlib,signal,stat as stat_module,time
data=json.loads(${JSON.stringify(JSON.stringify(endpoint))})
root=pathlib.Path(data['root'])
assert root.parent==pathlib.Path('/run/user/0') and root.name.startswith('serverdeck-plugin-components-${uuid}-') and root.resolve()==root and not root.is_symlink()
pid=data['pid'];stat=pathlib.Path('/proc/'+str(pid)+'/stat')
if stat.exists():
    raw=stat.read_text();start=raw[raw.rfind(')')+2:].split()[19]
    assert start==data['start'] and str(root/'sshd_config').encode() in pathlib.Path('/proc/'+str(pid)+'/cmdline').read_bytes()
    os.kill(pid,signal.SIGTERM)
    for _ in range(40):
        if not stat.exists() or stat.read_text().split(') ',1)[1].startswith('Z '):break
        time.sleep(0.05)
for item in list(root.iterdir()):
    assert item.name in ['authorized_keys','host-key','host-key.pub','sshd_config','sshd.log','sshd.pid']
    try:mode=item.lstat().st_mode
    except FileNotFoundError:
        if item.name=='sshd.pid':continue
        raise
    assert not item.is_symlink() and stat_module.S_ISREG(mode)
    item.unlink(missing_ok=True)
root.rmdir()
`);
    } catch (error) {
      failures.push(error);
    }
  const info = await lstat(key).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (info) {
    assert(info.isFile() && !info.isSymbolicLink() && path.dirname(key) === directory);
    await unlink(key);
  }
  if (keeperPid)
    try {
      linux(
        `import pathlib,os,signal\npid=${keeperPid}\ncmd=pathlib.Path('/proc/'+str(pid)+'/cmdline')\nif cmd.exists():\n    assert ${JSON.stringify(uuid)}.encode() in cmd.read_bytes()\n    os.kill(pid,signal.SIGTERM)\n`,
      );
    } catch (error) {
      failures.push(error);
    }
  if (keeper.exitCode === null) keeper.kill();
  if (failure) failures.unshift(failure);
  if (failures.length)
    throw new AggregateError(failures, 'owned plugin component test failed', {
      cause: failure ?? failures[0],
    });
}

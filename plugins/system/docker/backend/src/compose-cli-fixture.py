"""Run the production shell commands against private CLI executables, never a daemon."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

scripts = json.load(sys.stdin)
socket = "unix:///run/user/1234/docker.sock"
fake = r'''#!/usr/bin/python3
import json, os, sys
from pathlib import Path
entry = Path(sys.argv[0]).name
args = sys.argv[1:]
assert not any(os.environ.get(k) for k in ['DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])
if entry == 'docker':
    assert args[:2] == ['--host', 'unix:///run/user/1234/docker.sock'], args
    args = args[2:]
else:
    assert os.environ['DOCKER_HOST'] == 'unix:///run/user/1234/docker.sock'
with open(os.environ['SD_QA_CALLS'], 'a') as log:
    log.write(json.dumps([entry, args]) + '\n')
if entry == 'docker' and args[0] == 'compose':
    args = args[1:]
    version = os.environ['SD_QA_PLUGIN']
elif entry == 'docker-compose':
    version = os.environ['SD_QA_STANDALONE']
else:
    version = None
if version is not None:
    legacy = version.lstrip('v') == '1.29.2'
    if args == ['version', '--short']:
        if version == 'absent-long-help':
            print("unknown flag: --short\nSee 'docker --help'.", file=sys.stderr)
            print('Usage: docker [OPTIONS] COMMAND\n' * 100, file=sys.stderr)
            sys.exit(1)
        if version == 'absent':
            print('compose entry unavailable', file=sys.stderr)
            sys.exit(1)
        print(version)
        sys.exit(0)
    assert version != 'absent', 'business command reached an unavailable entry'
    if os.environ['SD_QA_FAIL'] == 'true':
        print('operation denied by fixture', file=sys.stderr)
        sys.exit(77)
    if args == ['ls', '--all', '--format', 'json']:
        print(json.dumps([{'Name':'shop', 'Status':'running(1)', 'ConfigFiles':'/srv/my app/compose.yaml'}]))
    elif args == ['config', '--help']:
        print('--no-interpolate' if legacy else '--format --no-interpolate')
    else:
        expected = ['--project-name','shop','--project-directory','/srv/my app']
        if not legacy:
            expected += ['--profile','*']
        expected += ['--file','/srv/my app/compose.yaml','--file','/srv/my app/override.yaml']
        assert args[:len(expected)] == expected, args
        tail = args[len(expected):]
        if tail[0] == 'config':
            if legacy:
                assert tail in [['config'], ['config','--no-interpolate']], tail
                print('services:\n  web:\n    image: nginx\n    environment:\n      TOKEN: fixture-secret')
            else:
                assert tail in [['config','--format','json'], ['config','--format','json','--no-interpolate']], tail
                print('{"services":{"web":{"image":"nginx","environment":{"TOKEN":"fixture-secret"}}}}')
        else:
            if legacy:
                if tail[0] == 'start':
                    assert tail == ['start','web','worker'], tail
                    tail = tail[:1]
                else:
                    assert tail[-3:] == ['--','web','worker'], tail
                    tail = tail[:-3]
            assert tail in [['start'], ['stop','--timeout','5'], ['restart','--timeout','5'],
                            ['logs','--no-color','--timestamps','--tail','100','--follow']], tail
            print('completed ' + tail[0])
    sys.exit(0)
if os.environ['SD_QA_FAIL'] == 'true':
    print('operation denied by fixture', file=sys.stderr)
    sys.exit(77)
assert args[:2] in [['container','ls'], ['container','inspect']], args
if args[1] == 'ls':
    print('a' * 64)
else:
    assert args[2] == '--format' and args[4:] == ['--', 'a' * 64], args
    fmt = args[3]
    labels = {'com.docker.compose.project':'shop',
              'com.docker.compose.project.working_dir':'/srv/my app',
              'com.docker.compose.project.config_files':'/srv/my app/compose.yaml,/srv/my app/override.yaml'}
    if fmt.startswith('{"ID":'):
        print(json.dumps({'ID':'a'*64,'Project':'shop','Service':'web','State':'running','OneOff':'False',
                          'ConfigFiles':labels['com.docker.compose.project.config_files']}))
    elif fmt.startswith('{"Id":'):
        print(json.dumps({'Id':'a'*64,'Project':'shop','WorkingDir':labels['com.docker.compose.project.working_dir'],
                          'ConfigFiles':labels['com.docker.compose.project.config_files']}))
    elif fmt.startswith('{{json'):
        print(json.dumps(labels['com.docker.compose.project.working_dir']) + ' ' +
              json.dumps(labels['com.docker.compose.project.config_files']))
    else:
        key = next(k for k in sorted(labels, key=len, reverse=True) if k in fmt)
        print(labels[key])
'''

with tempfile.TemporaryDirectory(prefix="serverdeck-compose-cli-") as folder:
    directory = Path(folder)
    calls_path = directory / "calls.jsonl"
    for name in ["docker", "docker-compose"]:
        executable = directory / name
        executable.write_text(fake)
        executable.chmod(0o700)

    def run(script, plugin, standalone, fail=False):
        calls_path.write_text("")
        setup = (f"export PATH={shlex.quote(folder)}:$PATH; sd_socket={shlex.quote(socket[7:])}; "
                 "cd() { test \"$1\" = '/srv/my app'; }; ")
        assert script.startswith(scripts["prelude"])
        script = script.replace(scripts["prelude"], scripts["prelude"] + setup, 1)
        env = dict(os.environ, SD_QA_PLUGIN=plugin, SD_QA_STANDALONE=standalone,
                   SD_QA_FAIL=str(fail).lower(), SD_QA_CALLS=str(calls_path),
                   DOCKER_HOST="tcp://wrong:2375", DOCKER_CONTEXT="wrong",
                   DOCKER_TLS_VERIFY="1", DOCKER_CERT_PATH="/wrong")
        result = subprocess.run(["sh", "-c", script], env=env, capture_output=True, text=True, timeout=5)
        calls = [json.loads(line) for line in calls_path.read_text().splitlines()]
        return result, calls

    for plugin, standalone, expected_entry in [("2.20.3", "2.20.3", "docker"),
                                                ("absent", "v2.20.3", "docker-compose"),
                                                ("5.1.3", "absent", "docker"),
                                                ("absent-long-help", "1.29.2", "docker-compose")]:
        for kind in ["projects", "config", "configRevealed", "start", "stop", "restart", "logs"]:
            result, calls = run(scripts[kind], plugin, standalone)
            assert result.returncode == 0, (kind, expected_entry, result.stderr)
            compose_calls = [(entry, args[1:] if entry == "docker" else args)
                             for entry, args in calls if entry == "docker-compose" or args[0] == "compose"]
            business = [(entry, args) for entry, args in compose_calls if args != ["version", "--short"]]
            if kind == "projects" and standalone == "1.29.2":
                assert not business and result.stdout.startswith('SERVERDECK_COMPOSE_V1\n'), (kind, calls)
            else:
                assert business and all(entry == expected_entry for entry, _ in business), (kind, calls)
            if expected_entry == "docker":
                assert not any(entry == "docker-compose" for entry, _ in calls), calls
            if kind == "projects":
                if standalone == "1.29.2":
                    assert json.loads(result.stdout.split('\n', 1)[1])["Project"] == "shop"
                else:
                    assert json.loads(result.stdout)[0]["Name"] == "shop"
            elif kind.startswith("config"):
                if standalone == "1.29.2":
                    row, end = json.JSONDecoder().raw_decode(result.stdout)
                    assert row['ModelFormat'] == 'yaml'
                    yaml = result.stdout[end+1:].encode()
                    assert len(yaml) == row['ModelBytes'] + 1 and b'image: nginx' in yaml
                else:
                    row = json.loads(result.stdout)
                    assert row["Model"]["services"]["web"]["image"] == "nginx", row
                assert row["ExitCode"] == 0
                assert row["EnvironmentFilesResolved"] is True
            else:
                assert result.stdout.strip() == "completed " + kind
                assert len(business) == 1, calls

    for plugin, standalone, expected_entry in [("2.20.3", "2.20.3", "docker"),
                                                ("absent", "2.20.3", "docker-compose"),
                                                ("absent", "1.29.2", "docker-compose")]:
        for kind in ["projects", "start", "stop", "restart", "logs"]:
            result, calls = run(scripts[kind], plugin, standalone, fail=True)
            assert result.returncode == 77 and "operation denied by fixture" in result.stderr, (kind, result)
            business = [(entry, args) for entry, args in calls
                        if (entry == "docker-compose" and args != ["version", "--short"])
                        or (entry == "docker" and args[0] == "compose" and args[1:] != ["version", "--short"])]
            if kind == 'projects' and standalone == '1.29.2':
                assert not business and calls[-1][1][:2] == ['container','ls'], calls
            else:
                assert len(business) == 1 and business[0][0] == expected_entry, calls

    for standalone in ["absent", "1.28.6", "unexpected version text"]:
        result, calls = run(scripts["projects"], "absent", standalone)
        assert result.returncode == 127 and "Compose V2" in result.stderr, result
        assert "docker compose:" in result.stderr and "docker-compose:" in result.stderr
        assert len(calls) == 2, calls

    result, calls = run(scripts["projects"], "absent-long-help", "1.28.6")
    assert result.returncode == 127 and len(calls) == 2
    visible = result.stderr.encode()[:1000].decode(errors="ignore")
    assert "1.29.2" in visible and "V2" in visible, visible
    assert "docker-compose: 1.28.6" in visible, visible
    assert "unknown flag: --short" in result.stderr

    result, calls = run(scripts["optionService"], "absent", "1.29.2")
    assert result.returncode == 2 and 'Compose V1' in result.stderr
    assert len(calls) == 2, 'V1 must reject ambiguous service arguments before executing start'
    result, calls = run(scripts["optionService"], "2.20.3", "absent")
    assert result.returncode == 0 and result.stdout.strip() == 'completed start'

print("Compose entry selection, JSON/config reads, fixed socket, actions/logs, errors and no-retry checks passed")

"""Owned loopback OpenSSH endpoint; no user accounts or SSH configuration changed."""
import hashlib
import json
import pathlib
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile


def main():
    public_key, shell = sys.argv[1:3]
    root = pathlib.Path(tempfile.mkdtemp(prefix="serverdeck-drop-ssh-", dir="/run/user/0"))
    destination = pathlib.Path(tempfile.mkdtemp(prefix="serverdeck-drop-payload-", dir="/var/tmp"))
    child = None
    try:
        (root / "authorized_keys").write_text(public_key + "\n")
        (root / "authorized_keys").chmod(0o600)
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(root / "host-key")], check=True)
        wrapper = root / "shell"
        wrapper.write_text("#!/bin/sh\ncd " + shlex.quote(str(destination)) + " || exit\nexport PS1='SD_SSH> '\nexec " + shlex.quote(shell) + " --noprofile --norc -i\n")
        wrapper.chmod(0o700)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        config = root / "sshd_config"
        config.write_text(f"""Port {port}
ListenAddress 127.0.0.1
HostKey {root}/host-key
PidFile {root}/sshd.pid
AuthorizedKeysFile {root}/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
AllowUsers root
UsePAM yes
StrictModes yes
ForceCommand {wrapper}
""")
        subprocess.run(["/usr/sbin/sshd", "-t", "-f", str(config)], check=True)
        child = subprocess.Popen(["/usr/sbin/sshd", "-D", "-e", "-f", str(config)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=sys.stderr)
        host_key = " ".join((root / "host-key.pub").read_text().split()[:2])
        print(json.dumps({"port": port, "publicKey": host_key, "directory": str(destination)}), flush=True)
        for line in sys.stdin:
            if line.strip() == "report":
                entries = {}
                for item in destination.rglob("*"):
                    if item.is_file():
                        digest = hashlib.sha256()
                        with item.open("rb") as stream:
                            for block in iter(lambda: stream.read(1024 * 1024), b""):
                                digest.update(block)
                        entries[str(item.relative_to(destination))] = digest.hexdigest()
                    else:
                        entries[str(item.relative_to(destination))] = None
                print(json.dumps(entries), flush=True)
            else:
                break
    finally:
        if child is not None:
            child.terminate()
            child.wait(timeout=10)
        if root.parent == pathlib.Path("/run/user/0") and root.name.startswith("serverdeck-drop-ssh-") and not root.is_symlink():
            shutil.rmtree(root)
        if destination.parent == pathlib.Path("/var/tmp") and destination.name.startswith("serverdeck-drop-payload-") and not destination.is_symlink():
            shutil.rmtree(destination)


if __name__ == "__main__":
    main()

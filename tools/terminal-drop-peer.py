"""Isolated Linux PTY peer for the production current-Shell upload protocol."""
import errno
import fcntl
import hashlib
import json
import os
import pathlib
import pwd
import pty
import selectors
import shutil
import subprocess
import sys
import tempfile
import termios
import time


def main():
    scenario = sys.argv[1]
    root = pathlib.Path(tempfile.mkdtemp(prefix="serverdeck-drop-"))
    destination = root / "destination"
    destination.mkdir()
    os.chmod(root, 0o755)
    account = pwd.getpwnam("nobody") if scenario != "sudo-root" else pwd.getpwuid(0)
    if scenario == "unnamed":
        account = pwd.struct_passwd(("", "", 2147483646, account.pw_gid, "", "/", "/bin/bash"))
        try:
            pwd.getpwuid(account.pw_uid)
        except KeyError:
            pass
        else:
            raise RuntimeError("UID chosen for unnamed-account test already has a name")
    if scenario != "permission":
        os.chown(destination, account.pw_uid, account.pw_gid)
    os.chmod(destination, 0o700)
    if scenario == "conflict-file":
        (destination / "plain.bin").write_bytes(b"existing-content")
    if scenario == "conflict-directory":
        (destination / "folder").mkdir()
    if scenario == "conflict-link":
        (destination / "plain.bin").symlink_to("missing-target")
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)

    def setup():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        os.setgroups([])
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)

    environment = dict(os.environ, HISTFILE="/dev/null", PS1="SD_TEST_PROMPT> ", PS2="> ")
    shell = ["sudo", "-i"] if scenario == "sudo-root" else ["/bin/bash", "--noprofile", "--norc", "-i"]
    child = subprocess.Popen(
        shell, cwd=destination,
        stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup, env=environment,
    )
    selector = selectors.DefaultSelector()
    selector.register(master, selectors.EVENT_READ)
    selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
    deadline = time.monotonic() + 90
    try:
        if scenario == "sudo-root":
            command = ("cd " + str(destination) + "; printf '\\036SD_PEER_READY\\037'\n").encode()
            os.write(master, command)
        while time.monotonic() < deadline:
            for key, _ in selector.select(0.05):
                if key.fd == master:
                    try:
                        data = os.read(master, 16384)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        data = b""
                    if data:
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()
                    elif child.poll() is not None:
                        break
                else:
                    data = os.read(key.fd, 16384)
                    if not data:
                        return 1
                    while data:
                        written = os.write(master, data)
                        data = data[written:]
            if child.poll() is not None:
                actual = termios.tcgetattr(slave)
                # Interactive Bash owns ICANON/ECHO while reading a prompt;
                # compare the terminal state after it exits, not during readline.
                restored = all(actual[i] == original[i] for i in range(4))
                entries = {}
                for item in destination.rglob("*"):
                    relative = str(item.relative_to(destination))
                    info = {"uid": item.lstat().st_uid, "mode": item.lstat().st_mode & 0o777}
                    if item.is_symlink():
                        info["link"] = os.readlink(item)
                    elif item.is_file():
                        info["sha256"] = hashlib.sha256(item.read_bytes()).hexdigest()
                    entries[relative] = info
                sys.stderr.write("SD_PEER_RESULT=" + json.dumps({
                    "status": child.returncode, "uid": account.pw_uid, "username": account.pw_name,
                    "restored": restored, "entries": entries,
                }, ensure_ascii=False) + "\n")
                return 0
        raise TimeoutError("current-Shell receiver timed out")
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        selector.close()
        os.close(master)
        os.close(slave)
        # root is a unique directory created above, never an application/user path.
        if root.parent == pathlib.Path("/tmp") and root.name.startswith("serverdeck-drop-"):
            shutil.rmtree(root)


if __name__ == "__main__":
    sys.exit(main())

"""Run on Linux with Python 3 and Bash to exercise the production Readline hook."""

import base64
import os
from pathlib import Path
import pty
import select
import signal
import tempfile
import time
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "src/session.bash"
TOKEN = "test-pane"


def encoded(value):
    return base64.b64encode(value.encode())


class Shell:
    def __init__(self, root, restore):
        rc = SOURCE.read_text().replace("__TOKEN__", TOKEN).replace("__RESTORE__", restore)
        launch = 'exec "$SHELL" --rcfile <(printf %s ' + encoded(rc).decode() + ' | base64 -d) -i'
        self.pid, self.pty = pty.fork()
        if self.pid == 0:
            os.chdir(root)
            os.execve("/bin/bash", ["bash", "-c", launch], {
                "HOME": str(root), "PATH": "/usr/bin:/bin", "SHELL": "/bin/bash",
                "TERM": "xterm-256color", "LC_ALL": "C.UTF-8",
            })
        self.buffer = b""

    def until(self, expected):
        deadline = time.monotonic() + 8
        while expected not in self.buffer:
            wait = max(0, deadline - time.monotonic())
            if not select.select([self.pty], [], [], wait)[0]:
                raise AssertionError(f"missing {expected!r} in isolated fixture: {self.buffer[-2000:]!r}")
            try:
                self.buffer += os.read(self.pty, 8192)
            except OSError as err:
                raise AssertionError(f"fixture PTY closed: {self.buffer[-2000:]!r}") from err
        _, self.buffer = self.buffer.split(expected, 1)

    def report(self, kind, value):
        self.until(b"\x1b]777;sd-ssh;test-pane;" + kind + b";" + encoded(value) + b"\x07")

    def send(self, data):
        os.write(self.pty, data)

    def close(self):
        os.close(self.pty)
        try:
            os.kill(self.pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        os.waitpid(self.pid, 0)


class SessionTest(unittest.TestCase):
    def test_capture_and_restore_only_on_enter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".bash_profile").write_text("PS1='ready> '; HISTCONTROL=ignorespace\n")
            work = root / "工程 '[test]"
            work.mkdir()
            line = "printf '%s' confirmed > ran"
            shell = Shell(root, "no")
            try:
                shell.report(b"cwd", str(root))
                shell.send(b'cd -- "' + str(work).encode() + b'"\n')
                shell.report(b"cwd", str(work))
                shell.send(b"sleep 0.15\n")
                shell.report(b"cmd", "sleep 0.15")
                shell.report(b"cwd", str(work))
                shell.send(b"read -rs fixture\n")
                shell.report(b"cmd", "read -rs fixture")
                shell.send(b"fixture-input\n")
                shell.report(b"cwd", str(work))
                shell.send(b" : ignored\n")
                shell.report(b"cmd", "")
            finally:
                shell.close()
            shell = Shell(root, "yes")
            try:
                shell.until(b"\x1b]777;sd-read;test-pane\x07")
                shell.send(encoded(str(work)) + b"\n" + encoded(line) + b"\n")
                shell.until(b"\x1b]777;sd-edit;test-pane\x07")
                shell.send(b"\x1b[777~")
                shell.report(b"cwd", str(work))
                shell.until(line.encode())
                self.assertFalse((work / "ran").exists())
                shell.send(b"-edited\n")
                shell.report(b"cmd", line + "-edited")
                shell.report(b"cwd", str(work))
                self.assertFalse((work / "ran").exists())
                self.assertEqual((work / "ran-edited").read_text(), "confirmed")
            finally:
                shell.close()

    def test_cancel_and_missing_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".bash_profile").write_text("PS1='ready> '\n")
            for target in [root, root / "missing"]:
                shell = Shell(root, "yes")
                try:
                    shell.until(b"\x1b]777;sd-read;test-pane\x07")
                    shell.send(encoded(str(target)) + b"\n" + encoded("touch should-not-run") + b"\n")
                    shell.until(b"\x1b]777;sd-edit;test-pane\x07")
                    shell.send(b"\x1b[777~")
                    shell.report(b"cwd", str(root))
                    if target == root:
                        shell.until(b"touch should-not-run")
                        shell.send(b"\x03")
                    else:
                        shell.send(b"\n")
                    shell.report(b"cwd", str(root))
                    self.assertFalse((root / "should-not-run").exists())
                finally:
                    shell.close()


if __name__ == "__main__":
    unittest.main()

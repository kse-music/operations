"""Run an isolated real lrzsz receiver on a Linux PTY for protocol acceptance."""

import errno
import fcntl
import os
import pty
import selectors
import subprocess
import sys
import termios
import time
import tty


def main():
    executable, destination = sys.argv[1:3]
    master, slave = pty.openpty()
    tty.setraw(slave)

    def setup_terminal():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    child = subprocess.Popen(
        [executable, "-b", "--protect"],
        cwd=destination,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        preexec_fn=setup_terminal,
    )
    os.close(slave)
    selector = selectors.DefaultSelector()
    selector.register(master, selectors.EVENT_READ)
    selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
    deadline = time.monotonic() + 60
    try:
        while time.monotonic() < deadline:
            for key, _ in selector.select(0.1):
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
                    else:
                        child.wait(timeout=5)
                        sys.stdout.buffer.write(f"\r\nZMODEM_RZ_EXIT={child.returncode}\r\n".encode())
                        sys.stdout.buffer.flush()
                        return child.returncode
                else:
                    data = os.read(key.fd, 16384)
                    if not data:
                        return 1
                    os.write(master, data)
        raise TimeoutError("isolated rz receiver timed out")
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        selector.close()
        os.close(master)


if __name__ == "__main__":
    sys.exit(main())

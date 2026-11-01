"""Exercise real pip recovery against a truncated local wheel, without external traffic.

Run with the plugin venv's Python after ensurePip. Only temporary files are installed.
"""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import zipfile


def verify():
    wheel_name = "garden_download_fixture-1.0.0-py3-none-any.whl"
    info = "garden_download_fixture-1.0.0.dist-info/"
    wheel = io.BytesIO()
    with zipfile.ZipFile(wheel, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("garden_download_fixture.py", 'VALUE = "recovered"\n')
        archive.writestr("garden_download_fixture_payload.bin", b"fixture" * 150000)
        archive.writestr(info + "METADATA", "Metadata-Version: 2.1\nName: garden-download-fixture\nVersion: 1.0.0\n")
        archive.writestr(info + "WHEEL", "Wheel-Version: 1.0\nGenerator: cyrene-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
        archive.writestr(info + "RECORD", "")
    data = wheel.getvalue()
    digest = hashlib.sha256(data).hexdigest()
    requests = []
    interrupted = False

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            nonlocal interrupted
            if self.path == "/simple/garden-download-fixture/":
                body = f'<a href="/{wheel_name}#sha256={digest}">{wheel_name}</a>'.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path == "/" + wheel_name:
                requested = self.headers.get("Range", "")
                requests.append(requested)
                start = int(requested.removeprefix("bytes=").split("-")[0]) if requested else 0
                self.send_response(206 if requested else 200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("ETag", f'"{digest}"')
                self.send_header("Content-Length", str(len(data) - start))
                if requested:
                    self.send_header("Content-Range", f"bytes {start}-{len(data)-1}/{len(data)}")
                self.end_headers()
                if not interrupted:
                    interrupted = True
                    self.wfile.write(data[:131072])
                    self.wfile.flush()
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                else:
                    self.wfile.write(data[start:])
            else:
                self.send_error(404)

    with tempfile.TemporaryDirectory(prefix="cyrene-pip-resume-") as directory:
        root = Path(directory)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            result = subprocess.run([
                sys.executable, "-m", "pip", "--isolated", "install",
                "--disable-pip-version-check", "--no-input", "--no-deps",
                "--resume-retries", "5", "--retries", "3", "--timeout", "5",
                "--cache-dir", str(root / "cache"), "--target", str(root / "installed"),
                "--index-url", f"http://127.0.0.1:{server.server_port}/simple/",
                "garden-download-fixture==1.0.0",
            ], capture_output=True, text=True, timeout=60,
                env={**os.environ, "PIP_CONFIG_FILE": os.devnull, "NO_PROXY": "127.0.0.1,localhost"})
            assert result.returncode == 0, result.stdout + result.stderr
            assert any(header.startswith("bytes=") and not header.startswith("bytes=0-") for header in requests), requests
            assert (root / "installed/garden_download_fixture.py").read_text() == 'VALUE = "recovered"\n'
            assert (root / "installed/garden_download_fixture_payload.bin").read_bytes() == b"fixture" * 150000
            print(json.dumps({"ok": True, "bytes": len(data), "interrupted": interrupted,
                              "requests": requests, "hashVerifiedByPip": True}))
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)


if __name__ == "__main__":
    verify()

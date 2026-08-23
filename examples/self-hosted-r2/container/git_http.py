#!/usr/bin/env python3

import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

HOST = "0.0.0.0"
PORT = 8080
DATA_ROOT = Path("/data")
REPO_PATH = DATA_ROOT / "repo.git"
BOOT_ID = str(uuid.uuid4())


def run_git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=check,
    )


def repo_head() -> str | None:
    if not REPO_PATH.exists():
        return None
    result = run_git("--git-dir", str(REPO_PATH), "rev-parse", "--verify", "HEAD", check=False)
    if result.returncode != 0:
        return None
    value = result.stdout.strip()
    return value or None


def ensure_repo() -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    if REPO_PATH.exists():
        return
    run_git("init", "--bare", "--initial-branch=main", str(REPO_PATH))
    run_git("--git-dir", str(REPO_PATH), "config", "http.receivepack", "true")


def reset_repo() -> None:
    if REPO_PATH.exists():
        shutil.rmtree(REPO_PATH)
    ensure_repo()


def fsck_repo() -> tuple[bool, str]:
    ensure_repo()
    result = run_git(
        "--git-dir",
        str(REPO_PATH),
        "fsck",
        "--no-reflogs",
        "--connectivity-only",
        check=False,
    )
    output = (result.stdout + result.stderr).strip()
    return result.returncode == 0, output


def copy_body_to_file(handler: BaseHTTPRequestHandler, out) -> int:
    transfer_encoding = (handler.headers.get("transfer-encoding") or "").lower()
    total = 0

    if "chunked" in transfer_encoding:
        while True:
            line = handler.rfile.readline()
            if not line:
                raise ConnectionError("unexpected EOF reading chunk header")
            size_text = line.split(b";", 1)[0].strip()
            size = int(size_text, 16)
            if size == 0:
                while True:
                    trailer = handler.rfile.readline()
                    if trailer in (b"\r\n", b"\n", b""):
                        break
                break
            remaining = size
            while remaining:
                chunk = handler.rfile.read(min(remaining, 1024 * 1024))
                if not chunk:
                    raise ConnectionError("unexpected EOF reading chunk body")
                out.write(chunk)
                total += len(chunk)
                remaining -= len(chunk)
            ending = handler.rfile.read(2)
            if ending != b"\r\n":
                raise ValueError("invalid chunk terminator")
        return total

    length = int(handler.headers.get("content-length") or "0")
    remaining = length
    while remaining:
        chunk = handler.rfile.read(min(remaining, 1024 * 1024))
        if not chunk:
            raise ConnectionError("unexpected EOF reading request body")
        out.write(chunk)
        total += len(chunk)
        remaining -= len(chunk)
    return total


def safe_extract(snapshot: Path, destination: Path) -> None:
    with tarfile.open(snapshot, "r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            member_path = Path(member.name)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise ValueError("snapshot contains an unsafe path")
            if member.issym() or member.islnk() or member.isdev():
                raise ValueError("snapshot contains an unsupported link or device")
            if not member_path.parts or member_path.parts[0] != "repo.git":
                raise ValueError("snapshot root must be repo.git")
        archive.extractall(destination)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "GitflareRepo/0.1"

    def log_message(self, format: str, *args) -> None:
        print(f"{self.address_string()} - {format % args}", flush=True)

    def send_json(self, status: int, body: object) -> None:
        payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(payload)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/__gitflare/status":
            ensure_repo()
            self.send_json(200, {"ok": True, "bootId": BOOT_ID, "head": repo_head()})
            return
        if parsed.path == "/__gitflare/export":
            self.handle_export()
            return
        self.handle_git()

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/__gitflare/reset":
            reset_repo()
            self.send_json(200, {"ok": True})
            return
        self.handle_git()

    def do_PUT(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/__gitflare/import":
            self.handle_import()
            return
        self.send_error(404)

    def handle_export(self) -> None:
        ok, details = fsck_repo()
        if not ok:
            self.send_json(500, {"ok": False, "error": "git fsck failed"})
            print(details, flush=True)
            return

        with tempfile.NamedTemporaryFile(suffix=".tar.gz") as tmp:
            with tarfile.open(tmp.name, "w:gz") as archive:
                archive.add(REPO_PATH, arcname="repo.git", recursive=True)
            size = os.path.getsize(tmp.name)
            self.send_response(200)
            self.send_header("content-type", "application/gzip")
            self.send_header("content-length", str(size))
            head = repo_head()
            if head:
                self.send_header("x-gitflare-head", head)
            self.end_headers()
            with open(tmp.name, "rb") as snapshot:
                shutil.copyfileobj(snapshot, self.wfile, length=1024 * 1024)

    def handle_import(self) -> None:
        DATA_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=DATA_ROOT, suffix=".tar.gz") as snapshot:
            copy_body_to_file(self, snapshot)
            snapshot.flush()
            import_root = DATA_ROOT / f"import-{uuid.uuid4()}"
            import_root.mkdir()
            old_repo = DATA_ROOT / f"repo-old-{uuid.uuid4()}"
            try:
                safe_extract(Path(snapshot.name), import_root)
                imported_repo = import_root / "repo.git"
                if not imported_repo.is_dir():
                    raise ValueError("snapshot does not contain repo.git")
                check = run_git(
                    "--git-dir",
                    str(imported_repo),
                    "fsck",
                    "--no-reflogs",
                    "--connectivity-only",
                    check=False,
                )
                if check.returncode != 0:
                    raise ValueError("restored repository failed git fsck")
                run_git("--git-dir", str(imported_repo), "config", "http.receivepack", "true")
                if REPO_PATH.exists():
                    REPO_PATH.rename(old_repo)
                imported_repo.rename(REPO_PATH)
                if old_repo.exists():
                    shutil.rmtree(old_repo)
            except Exception as error:
                if not REPO_PATH.exists() and old_repo.exists():
                    old_repo.rename(REPO_PATH)
                self.send_json(400, {"ok": False, "error": "invalid checkpoint"})
                print(f"checkpoint import failed: {error}", flush=True)
                return
            finally:
                shutil.rmtree(import_root, ignore_errors=True)

        self.send_json(200, {"ok": True, "head": repo_head()})

    def handle_git(self) -> None:
        parsed = urlsplit(self.path)
        if not parsed.path.startswith("/repo.git"):
            self.send_error(404)
            return

        ensure_repo()

        with tempfile.TemporaryFile() as request_body, tempfile.TemporaryFile() as output:
            body_size = 0
            if self.command in ("POST", "PUT", "PATCH"):
                body_size = copy_body_to_file(self, request_body)
                request_body.seek(0)

            env = os.environ.copy()
            env.update(
                {
                    "GIT_PROJECT_ROOT": str(DATA_ROOT),
                    "GIT_HTTP_EXPORT_ALL": "1",
                    "PATH_INFO": parsed.path,
                    "QUERY_STRING": parsed.query,
                    "REQUEST_METHOD": self.command,
                    "REMOTE_USER": "gitflare",
                    "REMOTE_ADDR": self.client_address[0],
                    "SERVER_PROTOCOL": self.request_version,
                    "SERVER_NAME": self.server.server_address[0],
                    "SERVER_PORT": str(self.server.server_address[1]),
                    "CONTENT_LENGTH": str(body_size),
                    "CONTENT_TYPE": self.headers.get("content-type", ""),
                }
            )
            git_protocol = self.headers.get("git-protocol")
            if git_protocol:
                env["HTTP_GIT_PROTOCOL"] = git_protocol
            accept = self.headers.get("accept")
            if accept:
                env["HTTP_ACCEPT"] = accept

            process = subprocess.Popen(
                ["git", "http-backend"],
                stdin=request_body,
                stdout=output,
                stderr=subprocess.PIPE,
                env=env,
            )
            _, stderr = process.communicate()
            if process.returncode != 0:
                self.send_json(500, {"ok": False, "error": "git http-backend failed"})
                print(stderr.decode("utf-8", errors="replace"), flush=True)
                return

            output.seek(0)
            status = 200
            response_headers: list[tuple[str, str]] = []
            while True:
                line = output.readline()
                if line in (b"\r\n", b"\n", b""):
                    break
                text = line.decode("latin-1").rstrip("\r\n")
                name, value = text.split(":", 1)
                value = value.strip()
                if name.lower() == "status":
                    status = int(value.split(" ", 1)[0])
                elif name.lower() not in ("connection", "transfer-encoding", "content-length"):
                    response_headers.append((name, value))

            body_start = output.tell()
            output.seek(0, io.SEEK_END)
            body_size = output.tell() - body_start
            output.seek(body_start)

            self.send_response(status)
            for name, value in response_headers:
                self.send_header(name, value)
            self.send_header("content-length", str(body_size))
            self.end_headers()
            shutil.copyfileobj(output, self.wfile, length=1024 * 1024)


if __name__ == "__main__":
    ensure_repo()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"gitflare repo container boot={BOOT_ID} listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()

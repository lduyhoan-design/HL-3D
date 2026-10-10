# -*- coding: utf-8 -*-
"""HL 3D (Chili3D Tiếng Việt) — máy chủ nhỏ chạy trên máy.

- Mở phần mềm (thư mục app/, là thư mục dist/ sau khi build) tại http://127.0.0.1:8787
- Lưu / mở đồ án (.cd) và xuất STL vào thư mục đồ án (mặc định ./do-an).
Không có phần AI: trợ lý AI trong app dùng API key của chính người dùng (nhập trong khung Trợ lý AI > Cài đặt).
Chỉ dùng thư viện có sẵn của Python 3.
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

APP_DIR = Path(__file__).resolve().parent
WEB = APP_DIR / "app" if (APP_DIR / "app" / "index.html").exists() else APP_DIR.parent / "dist"
PORT = int(os.environ.get("CHILI_PORT", "8787"))
CFG_FILE = APP_DIR / "cau-hinh.json"

for ext, t in ((".wasm", "application/wasm"), (".js", "text/javascript"), (".css", "text/css"),
               (".json", "application/json"), (".svg", "image/svg+xml")):
    mimetypes.add_type(t, ext)


def log(msg: str) -> None:
    try:
        print(time.strftime("%H:%M:%S ") + str(msg), flush=True)
    except Exception:  # noqa: BLE001
        pass


def _cfg() -> dict:
    try:
        return json.loads(CFG_FILE.read_text("utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def project_dir() -> Path:
    d = Path(_cfg().get("thu_muc_do_an") or (APP_DIR / "do-an"))
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception:  # noqa: BLE001
        d = APP_DIR / "do-an"
        d.mkdir(parents=True, exist_ok=True)
    return d


def set_project_dir(p: str) -> Path:
    c = _cfg()
    c["thu_muc_do_an"] = p
    CFG_FILE.write_text(json.dumps(c, ensure_ascii=False, indent=2), "utf-8")
    return project_dir()


def safe_name(name: str, ext: str) -> str:
    n = re.sub(r'[\\/:*?"<>|\r\n\t]+', "-", (name or "").strip()).strip(". ") or "do-an"
    return n if n.lower().endswith(ext) else n + ext


def open_in_explorer(p: Path) -> None:
    if os.name == "nt":
        os.startfile(str(p))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(p)])
    else:
        subprocess.Popen(["xdg-open", str(p)])


def choose_folder(start: Path) -> str | None:
    """Hộp chọn thư mục của Windows."""
    if os.name != "nt":
        return None
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$f=New-Object System.Windows.Forms.FolderBrowserDialog;"
        "$f.Description='Chọn thư mục lưu đồ án HL 3D';"
        f"$f.SelectedPath='{start}';"
        "$w=New-Object System.Windows.Forms.Form;$w.TopMost=$true;"
        "if($f.ShowDialog($w) -eq 'OK'){[Console]::OutputEncoding=[Text.Encoding]::UTF8;Write-Output $f.SelectedPath}"
    )
    r = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps], capture_output=True, timeout=600,
                       creationflags=0x08000000)
    return r.stdout.decode("utf-8", "ignore").strip() or None


class Handler(BaseHTTPRequestHandler):
    server_version = "HL3D"

    def log_message(self, fmt, *args):  # noqa: D401
        pass

    def _send(self, code: int, data: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _query(self) -> dict:
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    def do_GET(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path.startswith("/api/"):
            return self.api_get(path)
        if path in ("", "/"):
            path = "/index.html"
        f = (WEB / urllib.request.url2pathname(path.lstrip("/"))).resolve()
        if (WEB.resolve() not in f.parents and f != WEB.resolve()) or not f.is_file():
            return self._send(404, "Không tìm thấy".encode("utf-8"), "text/plain; charset=utf-8")
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        cache = "max-age=31536000, immutable" if re.search(r"\.[0-9a-f]{8}\.(js|css)$", f.name) else "no-cache"
        self._send(200, f.read_bytes(), ctype, {"Cache-Control": cache})

    def api_get(self, path: str):
        d = project_dir()
        if path == "/api/folder":
            return self._json({"folder": str(d)})
        if path == "/api/projects":
            items = [{"name": f.name, "size": f.stat().st_size, "mtime": int(f.stat().st_mtime * 1000)}
                     for f in sorted(d.glob("*.cd"), key=lambda x: x.stat().st_mtime, reverse=True)]
            return self._json({"folder": str(d), "items": items})
        if path == "/api/project":
            f = d / safe_name(self._query().get("name", ""), ".cd")
            if not f.is_file():
                return self._json({"error": "Không tìm thấy đồ án"}, 404)
            return self._send(200, f.read_bytes(), "application/json; charset=utf-8")
        return self._json({"error": "không có"}, 404)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if not path.startswith("/api/"):
            return self._json({"error": "không có"}, 404)
        d = project_dir()
        q = self._query()
        data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            if path == "/api/project":
                f = d / safe_name(q.get("name", ""), ".cd")
                f.write_bytes(data)
                log(f"[đồ án] đã lưu {f}")
                return self._json({"path": str(f)})
            if path == "/api/export":
                sub = d / "STL"
                sub.mkdir(exist_ok=True)
                f = sub / safe_name(q.get("name", ""), ".stl")
                f.write_bytes(data)
                log(f"[xuất] {f}")
                return self._json({"path": str(f)})
            if path == "/api/open-folder":
                sub = q.get("sub")
                target = d / sub if sub else d
                target.mkdir(exist_ok=True)
                open_in_explorer(target)
                return self._json({"ok": True, "folder": str(target)})
            if path == "/api/choose-folder":
                p = choose_folder(d)
                if p:
                    d = set_project_dir(p)
                return self._json({"folder": str(d), "changed": bool(p)})
        except Exception as e:  # noqa: BLE001
            log(f"[lỗi] {e}")
            return self._json({"error": str(e)}, 500)
        return self._json({"error": "không có"}, 404)


def main():
    url = f"http://127.0.0.1:{PORT}/"
    if not (WEB / "index.html").exists():
        log(f"Chưa có thư mục app (bản đã build). Chạy 'npm run build' rồi chép dist/ thành {APP_DIR / 'app'}")
        return
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        log("Máy chủ đã chạy sẵn, mở lại cửa sổ.")
        if "--khong-mo" not in sys.argv:
            webbrowser.open(url)
        return
    log(f"HL 3D đang chạy: {url}")
    if "--khong-mo" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    srv.serve_forever()


if __name__ == "__main__":
    main()

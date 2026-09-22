"""cadp278-hub — the UI. Serves one page and forwards /api/* to the ops API. No Docker access.

Published on 127.0.0.1:8780. Everything the page can do goes through ops' fixed routes; the
page reads state from the systems that own it (Conductor's event log, Preloop, MLflow) via ops,
and hands actions to them — it keeps no state of its own.
"""
import os, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OPS = os.environ.get("HUB_OPS_URL", "http://cadp278-ops:8781")
PAGE = open(os.path.join(os.path.dirname(__file__), "index.html"), "rb").read()


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"{self.command} {self.path.split('?')[0]} -> {args[1] if len(args) > 1 else ''}", flush=True)

    def _proxy(self, method):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else None
        req = urllib.request.Request(OPS + self.path, data=body, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                code, data = r.status, r.read()
        except urllib.error.HTTPError as e:
            code, data = e.code, e.read()
        except Exception as e:
            code, data = 502, ('{"error": "ops unreachable: %s"}' % type(e).__name__).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._proxy("GET")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self._proxy("POST")
        self.send_response(404); self.end_headers()


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8780), H).serve_forever()

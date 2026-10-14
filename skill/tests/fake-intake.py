#!/usr/bin/env python3
"""Minimal fake of the upload/finalize half of contracts/intake-openapi.yaml, for testing upload.sh offline.

Usage: fake-intake.py <token> <save-zip-path> [mode]
  mode: ok (default) | forbidden (every request answers 403, like a proxy)
Prints the port it listens on, then serves until killed. Standard library only.
"""
import hashlib
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

TOKEN, SAVE, MODE = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "ok")
STATE = {"uploaded": {}}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def _authed(self):
        return self.headers.get("Authorization") == f"Bearer {TOKEN}"

    def do_PUT(self):
        body = self._body()
        if MODE == "forbidden":
            return self._send(403, b"blocked by proxy", "text/plain")
        parts = self.path.split("/")
        if len(parts) != 5 or parts[1:3] != ["v1", "publish"] or parts[4] != "upload":
            return self._send(404)
        if not self._authed():
            return self._send(401)
        if self.headers.get("Content-Type") != "application/zip" or not body:
            return self._send(400)
        STATE["uploaded"][parts[3]] = hashlib.sha256(body).hexdigest()
        with open(SAVE, "wb") as f:
            f.write(body)
        self._send(201)

    def do_POST(self):
        body = self._body()
        if MODE == "forbidden":
            return self._send(403, b"blocked by proxy", "text/plain")
        parts = self.path.split("/")
        if len(parts) != 5 or parts[4] != "finalize":
            return self._send(404)
        if not self._authed():
            return self._send(401)
        job = parts[3]
        try:
            sha = json.loads(body)["sha256"]
        except (ValueError, KeyError):
            return self._send(400)
        if STATE["uploaded"].get(job) != sha:
            return self._send(409, json.dumps({"error": "hash mismatch"}).encode())
        self._send(202, json.dumps({"jobId": job, "state": "scanning", "updatedAt": "2026-01-01T00:00:00Z"}).encode())


srv = HTTPServer(("127.0.0.1", 0), H)
print(srv.server_address[1], flush=True)
srv.serve_forever()

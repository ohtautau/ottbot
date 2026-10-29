"""Private SSH-only proxy. No OpenAI key or Codex login is stored on this host."""
import hashlib
import hmac
import http.client
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 24 * 1024 * 1024


class RelayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass  # Requests may contain personal text; never log payloads or credentials.

    def error(self, status, message):
        body = json.dumps({"error": {"message": message, "type": "relay_error"}}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def forward(self):
        expected = ("Bearer " + self.server.settings["clientToken"]).encode()
        supplied = self.headers.get("Authorization", "").encode()
        if not hmac.compare_digest(hashlib.sha256(supplied).digest(), hashlib.sha256(expected).digest()):
            return self.error(401, "转接密钥不正确。请使用本机 CodeBuddy 配置文件中的转接密钥。")
        if (self.command, self.path) not in {
            ("GET", "/health"), ("GET", "/v1/models"), ("POST", "/v1/chat/completions")
        }:
            return self.error(404, "Unsupported relay endpoint")
        if self.headers.get("Transfer-Encoding"):
            return self.error(400, "Chunked request bodies are not supported")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.error(400, "Invalid Content-Length")
        if not 0 <= length <= MAX_BODY:
            return self.error(413, "Request too large (maximum 24 MB)")
        self.connection.settimeout(30)
        body = self.rfile.read(length)
        if len(body) != length:
            return self.error(400, "Incomplete request body")
        upstream = http.client.HTTPConnection("127.0.0.1", self.server.settings["workerPort"], timeout=920)
        started = False
        try:
            upstream.request(self.command, self.path, body=body, headers={
                "Authorization": "Bearer " + self.server.settings["workerToken"],
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
            })
            response = upstream.getresponse()
            self.send_response(response.status)
            self.send_header("Content-Type", response.getheader("Content-Type", "application/json"))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            started = True
            self.close_connection = True
            self.connection.settimeout(30)
            while chunk := response.read1(65536):
                self.wfile.write(chunk)
                self.wfile.flush()
        except (OSError, http.client.HTTPException):
            if not started:
                self.error(503, "本机 Codex 转接未连接。请在电脑运行 start-codex-bridge.cmd，并保持电脑在线。")
        finally:
            upstream.close()

    do_GET = forward
    do_POST = forward


def main():
    os.umask(0o077)
    with open(os.environ["OTTBOT_RELAY_CONFIG"], encoding="utf-8") as handle:
        config = json.load(handle)
    for key in ("clientToken", "workerToken"):
        if not isinstance(config.get(key), str) or len(config[key]) < 32:
            raise ValueError("Missing relay credentials")
    server = ThreadingHTTPServer(("127.0.0.1", config.get("port", 8089)), RelayHandler)
    server.daemon_threads = True
    server.settings = config
    print("ottbot relay listening on loopback", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

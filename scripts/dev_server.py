"""개발용 서버: 파일을 고치면 새로고침만으로 바로 반영되도록 브라우저 캐시를 끈다.

실행:  python scripts/dev_server.py        (기본 포트 8000)
       python scripts/dev_server.py 8001
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(NoCacheHandler, directory=str(ROOT)))
    print(f"http://localhost:{port} 에서 실행 중 (끄려면 Ctrl+C)")
    server.serve_forever()

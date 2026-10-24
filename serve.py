"""本機測試用的靜態伺服器：和 python -m http.server 一樣，但要求瀏覽器每次都重新檢查檔案，
改完程式重新整理就會生效，不會吃到舊的快取。

用法：python serve.py [port]（預設 8765）
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = partial(NoCacheHandler, directory=str(Path(__file__).parent))
    print(f"Serving on http://localhost:{port}")
    ThreadingHTTPServer(("", port), handler).serve_forever()

#!/usr/bin/env python3
"""
Serve the app for local use: python3 serve.py [port]   (default 8000)

The same as `python3 -m http.server`, plus two things:

- `Cache-Control: no-cache`. The stock server sends no caching instructions,
  so browsers guess how long each file stays fresh — for the app's modules,
  hours — and after an update a new index.html can run against an old
  main.js. no-cache makes the browser check every file on every load; an
  unchanged file costs one small 304 reply.

- Range requests. The stock server always sends the whole file. A <video>
  element needs ranges to seek, and opening a video by address (the `?src=`
  test route, see the README) reads it in pieces the same way — which is the
  only way to test a 12 GB video without the browser holding all of it.
"""

import functools
import http.server
import os
import re
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

    def send_head(self):
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', self.headers.get('Range', '').strip())
        path = self.translate_path(self.path)
        if not match or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        first, last = match.groups()
        if first == '':                      # the last N bytes
            start = max(0, size - int(last or 0))
            end = size - 1
        else:
            start = int(first)
            end = min(size - 1, int(last)) if last else size - 1
        if start >= size or start > end:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.end_headers()
            return None
        f = open(path, 'rb')
        f.seek(start)
        self.range = (start, end)
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        return f

    def copyfile(self, source, outputfile):
        span = getattr(self, 'range', None)
        if not span:
            return super().copyfile(source, outputfile)
        remaining = span[1] - span[0] + 1
        while remaining > 0:
            chunk = source.read(min(1 << 20, remaining))
            if not chunk:
                break
            try:
                outputfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                break                        # the browser moved on; fine
            remaining -= len(chunk)
        self.range = None


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(Handler, directory=root)
    # Every interface, as `python3 -m http.server` does.
    with http.server.ThreadingHTTPServer(('', port), handler) as server:
        print(f'Serving {root} at http://localhost:{port}/', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()

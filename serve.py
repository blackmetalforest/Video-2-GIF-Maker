#!/usr/bin/env python3
"""
Serve the app for local use: python3 serve.py [port]   (default 8000)

The same as `python3 -m http.server`, plus one header. The stock server sends
no caching instructions, so browsers guess how long each file stays fresh —
and for the app's modules they guess hours, reusing them without asking. After
an update that leaves a browser running a new index.html against an old
main.js, or a new main.js against an old module it imports, and the app dies
before a single button is wired up. `Cache-Control: no-cache` makes the browser
check every file on every load; an unchanged file costs one small 304 reply.
"""

import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=root)
    # Every interface, as `python3 -m http.server` does.
    with http.server.ThreadingHTTPServer(('', port), handler) as server:
        print(f'Serving {root} at http://localhost:{port}/', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Tiny static server for local testing of the Route Planner."""
import functools, http.server, os, socketserver

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 5176

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print("Serving %s at http://localhost:%d" % (ROOT, PORT), flush=True)
    httpd.serve_forever()

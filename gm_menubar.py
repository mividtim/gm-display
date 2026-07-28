#!/usr/bin/env python3
"""
GM Display Menu Bar App
Sits in the macOS menu bar (⚔️), runs the HTTP server, handles gm:// URLs.

Architecture:
  - NSApplication with NSStatusItem (menu bar icon)
  - HTTP server runs in a background thread
  - Handles gm:// URL scheme via Apple Events
  - No dock icon (accessory app)
"""

import os
import sys
import json
import threading
import time
import http.server
import urllib.parse
import urllib.request
import signal

# --- Import PyObjC ---
try:
    import objc
    from AppKit import (
        NSApplication, NSApp, NSObject, NSStatusBar, NSMenu, NSMenuItem,
        NSVariableStatusItemLength, NSWorkspace, NSImage,
        NSApplicationActivationPolicyAccessory, NSEventTrackingRunLoopMode
    )
    from Foundation import (
        NSURL, NSTimer, NSRunLoop, NSDefaultRunLoopMode, NSLog
    )
    HAS_PYOBJC = True
except ImportError:
    HAS_PYOBJC = False
    print("PyObjC not available — install with: pip3 install pyobjc-framework-Cocoa")
    print("Falling back to server-only mode.")


# ============================================================
# HTTP SERVER (same as server.py, embedded for single-process)
# ============================================================

PORT = 7680
IMAGE_ROOTS = []
pending_command = None
command_lock = threading.Lock()


class GMHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        # Poll for pending commands
        if parsed.path == '/api/command':
            global pending_command
            with command_lock:
                cmd = pending_command
                pending_command = None
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(cmd).encode() if cmd else b'null')
            return

        # Serve map/image files from configured roots
        if parsed.path.startswith('/maps/'):
            rel_path = urllib.parse.unquote(parsed.path[6:])
            for root in IMAGE_ROOTS:
                full_path = os.path.join(root, rel_path)
                if os.path.isfile(full_path):
                    try:
                        self.send_file(full_path)
                    except Exception as e:
                        print(f"Error serving {full_path}: {e}")
                        self.send_error(500, f"Error serving file: {e}")
                    return
            print(f"404: '{rel_path}' not found in {IMAGE_ROOTS}")
            self.send_error(404, f"Image not found: {rel_path}")
            return

        # List available maps
        if parsed.path == '/api/maps':
            maps = []
            for root in IMAGE_ROOTS:
                for dirpath, _, filenames in os.walk(root):
                    for f in filenames:
                        if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp', '.gif')):
                            rel = os.path.relpath(os.path.join(dirpath, f), root)
                            maps.append({'name': f, 'path': '/maps/' + urllib.parse.quote(rel)})
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(maps).encode())
            return

        # Health check
        if parsed.path == '/api/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'ok', 'roots': len(IMAGE_ROOTS)}).encode())
            return

        # Default: serve static files (no cache on HTML)
        if parsed.path == '/' or parsed.path == '':
            self.path = '/gm_display.html'

        if self.path.endswith('.html') or self.path.split('?')[0].endswith('.html'):
            clean_path = self.path.split('?')[0].lstrip('/')
            file_path = os.path.join(STATIC_DIR, clean_path)
            if os.path.isfile(file_path):
                with open(file_path, 'rb') as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', len(data))
                self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
                self.send_header('Pragma', 'no-cache')
                self.end_headers()
                self.wfile.write(data)
                return

        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == '/api/command':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode() if content_length else ''

            params = urllib.parse.parse_qs(parsed.query)
            cmd = None
            if body:
                try:
                    cmd = json.loads(body)
                except json.JSONDecodeError:
                    params.update(urllib.parse.parse_qs(body))

            if not cmd:
                url = params.get('url', [''])[0]
                if url:
                    cmd = parse_gm_url(url)
                else:
                    cmd = {
                        'action': params.get('action', ['show'])[0],
                        'file': params.get('file', [''])[0]
                    }

            global pending_command
            with command_lock:
                pending_command = cmd

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': True, 'command': cmd}).encode())
            return

        self.send_error(405)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def send_file(self, path):
        ext = os.path.splitext(path)[1].lower()
        mime_types = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.gif': 'image/gif', '.webp': 'image/webp',
        }
        mime = mime_types.get(ext, 'application/octet-stream')
        with open(path, 'rb') as f:
            data = f.read()
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', len(data))
        self.send_header('Cache-Control', 'max-age=3600')
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        if args and '404' in str(args[0]):
            super().log_message(format, *args)


def parse_gm_url(url):
    """Parse a gm://action/path URL into a command dict."""
    parsed = urllib.parse.urlparse(url)
    action = parsed.hostname  # 'show' or 'map'
    file_path = urllib.parse.unquote(parsed.path.lstrip('/'))
    return {
        'action': action or 'show',
        'file': f'/maps/{urllib.parse.quote(file_path)}'
    }


def send_command_to_server(url):
    """Send a gm:// URL to the running server via HTTP POST."""
    cmd = parse_gm_url(url)
    try:
        data = json.dumps(cmd).encode()
        req = urllib.request.Request(
            f'http://localhost:{PORT}/api/command',
            data=data,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        urllib.request.urlopen(req, timeout=2)
        return True
    except Exception as e:
        print(f"Failed to send command: {e}")
        return False


def add_vault(vault_path):
    """Add a vault root and all its immediate subfolders to IMAGE_ROOTS."""
    if vault_path not in IMAGE_ROOTS:
        IMAGE_ROOTS.append(vault_path)
    try:
        for sub in os.listdir(vault_path):
            sub_path = os.path.join(vault_path, sub)
            if os.path.isdir(sub_path) and not sub.startswith('.') and sub_path not in IMAGE_ROOTS:
                IMAGE_ROOTS.append(sub_path)
    except PermissionError:
        print(f"Warning: cannot list {vault_path}")


def discover_image_roots():
    """Find vault and image directories."""
    # Primary: walk up from our own location
    script_dir = os.path.dirname(os.path.abspath(__file__))

    # If running from .app bundle, Resources/ contains our files
    # but the vault is at the original location
    if '/Contents/Resources' in script_dir:
        # Running from .app bundle — find vault via known paths
        home = os.path.expanduser('~')
        for name in ['Documents/RPG/Campaign Vault', 'Documents/Pathfinder', 'Documents/Obsidian Vault']:
            candidate = os.path.join(home, name)
            if os.path.isdir(candidate):
                add_vault(candidate)
    else:
        # Running from vault directly (.tools/gm-display/)
        vault = os.path.dirname(os.path.dirname(script_dir))
        if os.path.isdir(vault):
            add_vault(vault)

    if not IMAGE_ROOTS:
        # Fallback: scan ~/Documents for Obsidian vaults
        home = os.path.expanduser('~')
        docs = os.path.join(home, 'Documents')
        if os.path.isdir(docs):
            for entry in os.listdir(docs):
                candidate = os.path.join(docs, entry)
                if os.path.isdir(candidate) and (
                    os.path.isdir(os.path.join(candidate, '.obsidian')) or
                    os.path.isdir(os.path.join(candidate, 'Darkmoon Vale'))
                ):
                    add_vault(candidate)


def start_http_server():
    """Start the HTTP server (blocking — run in a thread)."""
    try:
        server = http.server.HTTPServer(('127.0.0.1', PORT), GMHandler)
        print(f"GM Display Server running on http://localhost:{PORT}")
        print(f"Image roots: {IMAGE_ROOTS}")
        server.serve_forever()
    except OSError as e:
        if 'Address already in use' in str(e):
            print(f"Port {PORT} already in use — another instance may be running")
        else:
            raise


# Resolve STATIC_DIR — find where gm_display.html lives
def find_static_dir():
    """Find the directory containing gm_display.html."""
    candidates = [
        os.path.dirname(os.path.abspath(__file__)),  # same dir as this script
    ]
    # If in .app bundle, also check Resources
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if '/Contents/Resources' not in script_dir:
        # Not in bundle — also check .tools/gm-display/ relative to vault
        pass

    for d in candidates:
        if os.path.isfile(os.path.join(d, 'gm_display.html')):
            return d

    # Last resort
    return script_dir

STATIC_DIR = find_static_dir()


# ============================================================
# MENU BAR APP (PyObjC)
# ============================================================

if HAS_PYOBJC:

    class GMDisplayDelegate(NSObject):
        """NSApplication delegate — creates menu bar icon, manages server."""

        def applicationDidFinishLaunching_(self, notification):
            # Hide dock icon — we're a menu bar app only
            NSApp.setActivationPolicy_(NSApplicationActivationPolicyAccessory)

            # Create status bar item
            self.statusItem = NSStatusBar.systemStatusBar().statusItemWithLength_(
                NSVariableStatusItemLength
            )
            self.statusItem.setTitle_("\u2694\uFE0F")  # ⚔️
            self.statusItem.setHighlightMode_(True)

            self._server_ok = False
            self._build_menu()

            # Start server
            self._server_thread = threading.Thread(target=start_http_server, daemon=True)
            self._server_thread.start()

            # Health check every 5 seconds
            self._health_timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
                3.0, self, b"healthCheck:", None, True
            )
            # Initial check after 1s
            NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
                1.0, self, b"healthCheck:", None, False
            )

        def _build_menu(self):
            menu = NSMenu.alloc().init()

            # Status line (disabled, just informational)
            self._status_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
                "Server: starting...", None, ""
            )
            self._status_item.setEnabled_(False)
            menu.addItem_(self._status_item)

            self._roots_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
                f"Image roots: {len(IMAGE_ROOTS)}", None, ""
            )
            self._roots_item.setEnabled_(False)
            menu.addItem_(self._roots_item)

            menu.addItem_(NSMenuItem.separatorItem())

            # Open pages
            item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
                "Open GM Page", b"openGMPage:", ""
            )
            menu.addItem_(item)

            item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
                "Open Map Display (Projector)", b"openMapDisplay:", ""
            )
            menu.addItem_(item)

            item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
                "Open Image Display (Sidecar)", b"openSidecarDisplay:", ""
            )
            menu.addItem_(item)

            menu.addItem_(NSMenuItem.separatorItem())

            # Restart
            item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
                "Restart Server", b"restartServer:", ""
            )
            menu.addItem_(item)

            menu.addItem_(NSMenuItem.separatorItem())

            # Quit
            item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
                "Quit GM Display", b"quitApp:", "q"
            )
            menu.addItem_(item)

            self.statusItem.setMenu_(menu)

        @objc.typedSelector(b"v@:@")
        def healthCheck_(self, timer):
            """Periodic server health check — updates menu bar icon."""
            try:
                req = urllib.request.Request(f'http://localhost:{PORT}/api/health', method='GET')
                resp = urllib.request.urlopen(req, timeout=1)
                data = json.loads(resp.read())
                self._server_ok = True
                self._status_item.setTitle_(f"Server: running \u2714")
                self._roots_item.setTitle_(f"Image roots: {data.get('roots', '?')}")
                self.statusItem.setTitle_("\u2694\uFE0F")
            except Exception:
                self._server_ok = False
                self._status_item.setTitle_("Server: not responding \u2718")
                self.statusItem.setTitle_("\u2694\uFE0F \u26A0")

        @objc.typedSelector(b"v@:@")
        def openGMPage_(self, sender):
            NSWorkspace.sharedWorkspace().openURL_(
                NSURL.URLWithString_("http://localhost:7680")
            )

        @objc.typedSelector(b"v@:@")
        def openMapDisplay_(self, sender):
            NSWorkspace.sharedWorkspace().openURL_(
                NSURL.URLWithString_("http://localhost:7680/gm_display.html?mode=player&display=map")
            )

        @objc.typedSelector(b"v@:@")
        def openSidecarDisplay_(self, sender):
            NSWorkspace.sharedWorkspace().openURL_(
                NSURL.URLWithString_("http://localhost:7680/gm_display.html?mode=player&display=show")
            )

        @objc.typedSelector(b"v@:@")
        def restartServer_(self, sender):
            self._status_item.setTitle_("Server: restarting...")
            self.statusItem.setTitle_("\u2694\uFE0F ...")
            # Kill the old server thread (it's daemon, will die)
            # Start a new one
            import socket
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.connect(('127.0.0.1', PORT))
                s.close()
            except:
                pass
            self._server_thread = threading.Thread(target=start_http_server, daemon=True)
            self._server_thread.start()

        @objc.typedSelector(b"v@:@")
        def quitApp_(self, sender):
            NSApp.terminate_(None)

        # --- Handle gm:// URLs sent to the app ---
        def application_openURLs_(self, app, urls):
            for url in urls:
                url_string = str(url.absoluteString())
                if url_string.startswith('gm://'):
                    print(f"Received URL: {url_string}")
                    cmd = parse_gm_url(url_string)
                    global pending_command
                    with command_lock:
                        pending_command = cmd


# ============================================================
# MAIN
# ============================================================

def main():
    # Handle CLI mode: if called with a gm:// URL, POST it and exit
    for arg in sys.argv[1:]:
        if arg.startswith('gm://'):
            send_command_to_server(arg)
            return
        elif os.path.isdir(arg):
            IMAGE_ROOTS.append(os.path.abspath(arg))

    # Discover image roots
    discover_image_roots()

    if HAS_PYOBJC:
        # Run as menu bar app
        app = NSApplication.sharedApplication()
        delegate = GMDisplayDelegate.alloc().init()
        app.setDelegate_(delegate)
        app.run()
    else:
        # Fallback: just run the server
        print("Running in server-only mode (no menu bar icon)")
        import webbrowser
        threading.Timer(0.5, lambda: webbrowser.open(f'http://localhost:{PORT}')).start()
        start_http_server()


if __name__ == '__main__':
    main()

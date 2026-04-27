import Cocoa

// ============================================================
// GM Display — macOS Menu Bar App
// Sits in the menu bar as ⚔️, runs the Python HTTP server,
// handles gm:// URL scheme.
// ============================================================

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var serverProcess: Process?
    var healthTimer: Timer?
    var statusMenuItem: NSMenuItem!
    var rootsMenuItem: NSMenuItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        // No dock icon — menu bar only
        NSApp.setActivationPolicy(.accessory)

        // Create status bar item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "⚔️"

        buildMenu()
        startServer()

        // Health check every 5s
        healthTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.checkHealth()
        }
        // Initial check after 2s
        Timer.scheduledTimer(withTimeInterval: 2.0, repeats: false) { [weak self] _ in
            self?.checkHealth()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    func buildMenu() {
        let menu = NSMenu()

        statusMenuItem = NSMenuItem(title: "Server: starting...", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)

        rootsMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        rootsMenuItem.isEnabled = false
        menu.addItem(rootsMenuItem)

        menu.addItem(NSMenuItem.separator())

        let openGM = NSMenuItem(title: "Open GM Page", action: #selector(openGMPage), keyEquivalent: "g")
        openGM.target = self
        menu.addItem(openGM)

        let openMap = NSMenuItem(title: "Open Map Display (Projector)", action: #selector(openMapDisplay), keyEquivalent: "m")
        openMap.target = self
        menu.addItem(openMap)

        let openSidecar = NSMenuItem(title: "Open Image Display (Sidecar)", action: #selector(openSidecarDisplay), keyEquivalent: "s")
        openSidecar.target = self
        menu.addItem(openSidecar)

        menu.addItem(NSMenuItem.separator())

        let restart = NSMenuItem(title: "Restart Server", action: #selector(restartServer), keyEquivalent: "r")
        restart.target = self
        menu.addItem(restart)

        menu.addItem(NSMenuItem.separator())

        let quit = NSMenuItem(title: "Quit GM Display", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
    }

    // === Server Management ===

    func getServerScriptPath() -> String {
        // Look for server.py relative to the app bundle
        let bundle = Bundle.main
        if let resPath = bundle.resourcePath {
            let candidate = resPath + "/server.py"
            if FileManager.default.fileExists(atPath: candidate) {
                return candidate
            }
        }
        // Fallback: look in the vault's .tools directory
        let home = NSHomeDirectory()
        let vaultServer = home + "/Documents/Pathfinder/.tools/gm-display/server.py"
        if FileManager.default.fileExists(atPath: vaultServer) {
            return vaultServer
        }
        return home + "/Documents/Pathfinder/.tools/gm-display/server.py"
    }

    func startServer() {
        // Kill anything on port 7680 first
        let killTask = Process()
        killTask.executableURL = URL(fileURLWithPath: "/bin/bash")
        killTask.arguments = ["-c", "lsof -ti :7680 2>/dev/null | xargs kill 2>/dev/null; sleep 0.3"]
        try? killTask.run()
        killTask.waitUntilExit()

        let scriptPath = getServerScriptPath()
        NSLog("Starting server from: \(scriptPath)")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = [scriptPath, "--no-browser"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        // Set working directory to script location for STATIC_DIR resolution
        process.currentDirectoryURL = URL(fileURLWithPath: scriptPath).deletingLastPathComponent()

        do {
            try process.run()
            serverProcess = process
            statusMenuItem.title = "Server: starting..."
            NSLog("Server PID: \(process.processIdentifier)")
        } catch {
            NSLog("Failed to start server: \(error)")
            statusMenuItem.title = "Server: failed to start"
            statusItem.button?.title = "⚔️ ✗"
        }
    }

    func stopServer() {
        serverProcess?.terminate()
        serverProcess = nil
    }

    // === Health Check ===

    func checkHealth() {
        let url = URL(string: "http://localhost:7680/api/health")!
        let task = URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            DispatchQueue.main.async {
                if let data = data,
                   let http = response as? HTTPURLResponse,
                   http.statusCode == 200,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    let roots = json["roots"] as? Int ?? 0
                    self?.statusMenuItem.title = "Server: running ✓"
                    self?.rootsMenuItem.title = "Image roots: \(roots)"
                    self?.statusItem.button?.title = "⚔️"
                } else {
                    // Server might have crashed — try to restart
                    if let proc = self?.serverProcess, !proc.isRunning {
                        self?.statusMenuItem.title = "Server: crashed — restarting..."
                        self?.startServer()
                    } else {
                        self?.statusMenuItem.title = "Server: not responding"
                        self?.statusItem.button?.title = "⚔️ ⚠"
                    }
                }
            }
        }
        task.resume()
    }

    // === Menu Actions ===

    @objc func openGMPage() {
        NSWorkspace.shared.open(URL(string: "http://localhost:7680")!)
    }

    @objc func openMapDisplay() {
        NSWorkspace.shared.open(URL(string: "http://localhost:7680/gm_display.html?mode=player&display=map")!)
    }

    @objc func openSidecarDisplay() {
        NSWorkspace.shared.open(URL(string: "http://localhost:7680/gm_display.html?mode=player&display=show")!)
    }

    @objc func restartServer() {
        statusMenuItem.title = "Server: restarting..."
        statusItem.button?.title = "⚔️ ..."
        stopServer()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.startServer()
        }
    }

    @objc func quitApp() {
        stopServer()
        NSApp.terminate(nil)
    }

    // === Handle gm:// URLs ===

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            let urlString = url.absoluteString
            if urlString.hasPrefix("gm://") {
                NSLog("Received URL: \(urlString)")
                postCommand(urlString: urlString)
            }
        }
    }

    func postCommand(urlString: String) {
        // Parse gm://action/path
        guard let url = URLComponents(string: urlString) else { return }
        let action = url.host ?? "show"
        let filePath = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .removingPercentEncoding ?? url.path

        let encodedPath = filePath.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? filePath
        let command: [String: String] = [
            "action": action,
            "file": "/maps/\(encodedPath)"
        ]

        guard let jsonData = try? JSONSerialization.data(withJSONObject: command) else { return }

        var request = URLRequest(url: URL(string: "http://localhost:7680/api/command")!)
        request.httpMethod = "POST"
        request.httpBody = jsonData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        URLSession.shared.dataTask(with: request) { _, _, error in
            if let error = error {
                NSLog("Failed to post command: \(error)")
            }
        }.resume()
    }
}

// === Main ===
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()

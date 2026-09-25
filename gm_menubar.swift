import Cocoa

// ============================================================
// GM Display — menu-bar app (⚔️)
//
// This app is THE thing that runs the server. Nothing else should:
//
//   * It runs server.py straight out of the vault — never a copy baked into
//     the app bundle — so a restart always runs the code that is on disk now.
//   * The server is its child process, so macOS asks once whether "GM
//     Display" may read your Documents folder and remembers the answer. (A
//     launchd job running python on its own gets "Operation not permitted" on
//     everything in ~/Documents, which is why the old daemon never worked.)
//   * It owns port 7680: starting or restarting takes the port from whoever
//     holds it, and it unloads the old launchd job so that cannot respawn.
//   * The server also restarts ITSELF when its own .py files change, so an
//     update is live without touching this menu at all. "Restart Server" is
//     for when you want to be sure.
//
// Settings live beside server.py in gm-display.conf (read on every start).
// Log: ~/Library/Logs/gm-display.log
// ============================================================

let PORT = 7680
let LEGACY_LABEL = "com.gm-display.server"

struct Config {
    var python = "/usr/bin/python3"
    var browser = ""               // e.g. open -na Dia --args --profile-directory=Default {url}
    var openAtLaunch = true
    var serverArgs: [String] = []
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var statusLine: NSMenuItem!
    var detailLine: NSMenuItem!
    var startStopItem: NSMenuItem!

    var server: Process?
    var stopping = false           // an exit we asked for — do not restart
    var recentExits: [Date] = []
    var healthTimer: Timer?
    var pendingURLs: [String] = []
    var retiredPIDs = Set<Int32>()  // servers we stopped on purpose

    // Where server.py lives. build_app.sh writes it into Info.plist.
    lazy var toolsDir: String = {
        if let d = Bundle.main.object(forInfoDictionaryKey: "GMDToolsDir") as? String, !d.isEmpty {
            return d
        }
        return NSHomeDirectory() + "/Documents/RPG/Campaign Vault/.tools/gm-display"
    }()
    var serverScript: String { toolsDir + "/server.py" }
    var confPath: String { toolsDir + "/gm-display.conf" }
    var logPath: String { NSHomeDirectory() + "/Library/Logs/gm-display.log" }

    // MARK: - lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "⚔️"
        buildMenu()

        let cfg = readConfig()
        startServer(openPageWhenUp: cfg.openAtLaunch)

        healthTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.checkHealth()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.checkHealth() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopServerSync()
    }

    // MARK: - menu

    func buildMenu() {
        let menu = NSMenu()
        statusLine = NSMenuItem(title: "Server: starting…", action: nil, keyEquivalent: "")
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        detailLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        detailLine.isEnabled = false
        menu.addItem(detailLine)
        menu.addItem(NSMenuItem.separator())

        add(menu, "Open GM Page", #selector(openGMPage), "g")
        add(menu, "Open Projector", #selector(openProjector), "")
        add(menu, "Open Sidecar", #selector(openSidecar), "")
        add(menu, "Preview Player View", #selector(openPlayerPreview), "p")
        menu.addItem(NSMenuItem.separator())

        add(menu, "Restart Server", #selector(restartServer), "r")
        startStopItem = add(menu, "Stop Server", #selector(toggleServer), "")
        add(menu, "Show Log", #selector(showLog), "l")
        add(menu, "Edit Settings (gm-display.conf)", #selector(editConfig), "")
        add(menu, "Reveal Server Folder", #selector(revealFolder), "")
        menu.addItem(NSMenuItem.separator())

        add(menu, "Quit GM Display", #selector(quitApp), "q")
        statusItem.menu = menu
    }

    @discardableResult
    func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        menu.addItem(item)
        return item
    }

    // MARK: - config

    func readConfig() -> Config {
        var cfg = Config()
        guard let text = try? String(contentsOfFile: confPath, encoding: .utf8) else { return cfg }
        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            if line.hasPrefix("--") { cfg.serverArgs.append(line); continue }
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            switch key {
            case "python": if !value.isEmpty { cfg.python = value }
            case "browser": cfg.browser = value
            case "open-gm-page-at-launch": cfg.openAtLaunch = !["no", "false", "0", "off"].contains(value.lowercased())
            default: break
            }
        }
        return cfg
    }

    // MARK: - server

    func startServer(openPageWhenUp: Bool = false) {
        stopping = false
        let cfg = readConfig()
        guard FileManager.default.fileExists(atPath: serverScript) else {
            setStatus("Server: server.py not found", icon: "⚔️ ✗")
            detailLine.title = serverScript
            return
        }
        retireLegacyDaemon()
        freePort()
        rotateLogIfBig()

        let fm = FileManager.default
        if !fm.fileExists(atPath: logPath) { fm.createFile(atPath: logPath, contents: nil) }
        let log = FileHandle(forWritingAtPath: logPath)
        log?.seekToEndOfFile()
        let stamp = ISO8601DateFormatter().string(from: Date())
        log?.write("\n==== GM Display menu-bar app starting server \(stamp) ====\n".data(using: .utf8)!)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: cfg.python)
        p.arguments = [serverScript, "--no-browser"] + cfg.serverArgs
        p.currentDirectoryURL = URL(fileURLWithPath: toolsDir)
        var env = ProcessInfo.processInfo.environment
        env["GMD_SUPERVISOR"] = "tray"
        env["PYTHONUNBUFFERED"] = "1"
        p.environment = env
        if let log = log {
            p.standardOutput = log
            p.standardError = log
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.serverExited(proc) }
        }
        do {
            try p.run()
            server = p
            setStatus("Server: starting…", icon: "⚔️ …")
            startStopItem.title = "Stop Server"
            if openPageWhenUp { whenUp { [weak self] in self?.openGMPage() } }
            whenUp { [weak self] in self?.flushPendingURLs() }
        } catch {
            setStatus("Server: could not start python", icon: "⚔️ ✗")
            detailLine.title = "\(cfg.python): \(error.localizedDescription)"
        }
    }

    func serverExited(_ proc: Process) {
        if retiredPIDs.remove(proc.processIdentifier) != nil { return }
        if server === proc { server = nil }
        if stopping { return }
        // Something else may have taken the port on purpose (server.py --force
        // from a Terminal). Do not fight it for the port.
        fetchHealth { [weak self] h in
            guard let self = self else { return }
            if let h = h, (h["supervisor"] as? String) != "tray" {
                self.setStatus("Server: running from Terminal (not managed here)", icon: "⚔️ ⌨")
                self.startStopItem.title = "Take Over Server"
                return
            }
            let now = Date()
            self.recentExits = self.recentExits.filter { now.timeIntervalSince($0) < 60 } + [now]
            if self.recentExits.count >= 4 {
                self.setStatus("Server: keeps crashing — see Show Log", icon: "⚔️ ✗")
                self.startStopItem.title = "Start Server"
                return
            }
            self.setStatus("Server: exited — restarting…", icon: "⚔️ …")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self = self, !self.stopping, self.server == nil else { return }
                self.startServer()
            }
        }
    }

    // Stop our server and wait for it (SIGTERM, then SIGKILL after 4s).
    func stopServerSync() {
        stopping = true
        guard let p = server, p.isRunning else { server = nil; return }
        let pid = p.processIdentifier
        DispatchQueue.main.async { self.retiredPIDs.insert(pid) }
        p.terminate()
        let deadline = Date().addingTimeInterval(4)
        while p.isRunning && Date() < deadline { usleep(100_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        server = nil
    }

    // The port has one owner. Whatever is listening on it now — a Terminal
    // copy, a leftover from an old install — is asked to stop, then made to.
    func freePort() {
        let out = sh("/usr/sbin/lsof -nP -ti tcp:\(PORT) -sTCP:LISTEN 2>/dev/null")
        let mine = server?.processIdentifier ?? -1
        let pids = out.split(separator: "\n").compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
            .filter { $0 != mine && $0 != getpid() }
        if pids.isEmpty { return }
        for pid in pids { kill(pid, SIGTERM) }
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline && pids.contains(where: { kill($0, 0) == 0 }) { usleep(100_000) }
        for pid in pids where kill(pid, 0) == 0 { kill(pid, SIGKILL) }
        usleep(300_000)
    }

    // The old launchd daemon ran python without Documents access and fought
    // this app for the port (KeepAlive respawned it thousands of times). Make
    // sure it is gone.
    func retireLegacyDaemon() {
        let uid = getuid()
        _ = sh("/bin/launchctl bootout gui/\(uid)/\(LEGACY_LABEL) 2>/dev/null")
        let plist = NSHomeDirectory() + "/Library/LaunchAgents/\(LEGACY_LABEL).plist"
        if FileManager.default.fileExists(atPath: plist) {
            try? FileManager.default.trashItem(at: URL(fileURLWithPath: plist), resultingItemURL: nil)
        }
    }

    func rotateLogIfBig() {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: logPath),
              let size = attrs[.size] as? NSNumber, size.intValue > 5_000_000 else { return }
        let old = logPath + ".old"
        try? fm.removeItem(atPath: old)
        try? fm.moveItem(atPath: logPath, toPath: old)
    }

    // MARK: - health

    func fetchHealth(_ done: @escaping ([String: Any]?) -> Void) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(PORT)/api/health")!)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            var out: [String: Any]? = nil
            if let data = data, let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                out = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            }
            DispatchQueue.main.async { done(out) }
        }.resume()
    }

    // Run `then` once the server answers (gives up after ~20s).
    func whenUp(tries: Int = 40, _ then: @escaping () -> Void) {
        fetchHealth { [weak self] h in
            if h != nil { then(); return }
            if tries <= 0 { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self?.whenUp(tries: tries - 1, then) }
        }
    }

    func checkHealth() {
        fetchHealth { [weak self] h in
            guard let self = self else { return }
            guard let h = h else {
                if self.server?.isRunning == true {
                    self.setStatus("Server: starting…", icon: "⚔️ …")
                } else if !self.stopping && self.recentExits.count < 4 {
                    self.setStatus("Server: not running", icon: "⚔️ ⚠")
                } else if self.stopping {
                    self.setStatus("Server: stopped", icon: "⚔️ ◌")
                    self.startStopItem.title = "Start Server"
                }
                return
            }
            let pid = (h["pid"] as? NSNumber)?.intValue ?? 0
            let managed = (h["supervisor"] as? String) == "tray"
            var since = ""
            if let t = h["started"] as? Double {
                let f = DateFormatter(); f.dateFormat = "HH:mm:ss"
                since = " · since \(f.string(from: Date(timeIntervalSince1970: t)))"
            }
            if managed {
                self.setStatus("Server: running ✓", icon: "⚔️")
                self.startStopItem.title = "Stop Server"
            } else {
                self.setStatus("Server: running from Terminal (not managed here)", icon: "⚔️ ⌨")
                self.startStopItem.title = "Take Over Server"
            }
            let py = (h["python"] as? String).map { " · python \($0)" } ?? ""
            self.detailLine.title = "pid \(pid)\(since)\(py) · port \(PORT)"
        }
    }

    func setStatus(_ text: String, icon: String) {
        statusLine.title = text
        statusItem.button?.title = icon
    }

    // MARK: - actions

    @objc func restartServer() {
        setStatus("Server: restarting…", icon: "⚔️ …")
        recentExits = []
        DispatchQueue.global().async { [weak self] in
            self?.stopServerSync()
            DispatchQueue.main.async { self?.startServer() }
        }
    }

    @objc func toggleServer() {
        if startStopItem.title == "Stop Server" {
            setStatus("Server: stopping…", icon: "⚔️ …")
            DispatchQueue.global().async { [weak self] in
                self?.stopServerSync()
                DispatchQueue.main.async {
                    self?.setStatus("Server: stopped", icon: "⚔️ ◌")
                    self?.startStopItem.title = "Start Server"
                }
            }
        } else {
            recentExits = []
            startServer()
        }
    }

    @objc func openGMPage() { openInBrowser("/gm.html") }
    @objc func openProjector() { openInBrowser("/display.html?display=map") }
    @objc func openSidecar() { openInBrowser("/display.html?display=show") }
    @objc func openPlayerPreview() { openInBrowser("/remote.html?preview=1") }

    // Opens in the browser (and PROFILE) named in gm-display.conf, because the
    // whole app lives in that profile's localStorage.
    func openInBrowser(_ path: String) {
        let url = "http://localhost:\(PORT)\(path)"
        let cfg = readConfig()
        if cfg.browser.isEmpty {
            NSWorkspace.shared.open(URL(string: url)!)
            return
        }
        let quoted = "'" + url + "'"
        let cmd = cfg.browser.contains("{url}")
            ? cfg.browser.replacingOccurrences(of: "{url}", with: quoted)
            : cfg.browser + " " + quoted
        DispatchQueue.global().async { _ = self.sh(cmd) }
    }

    @objc func showLog() {
        _ = sh("/usr/bin/open -a Console '\(logPath)'")
    }

    @objc func editConfig() {
        if !FileManager.default.fileExists(atPath: confPath) {
            FileManager.default.createFile(atPath: confPath, contents: "# See gm-display.conf in the repo\n".data(using: .utf8))
        }
        NSWorkspace.shared.open(URL(fileURLWithPath: confPath))
    }

    @objc func revealFolder() {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: serverScript)])
    }

    @objc func quitApp() {
        stopServerSync()
        NSApp.terminate(nil)
    }

    // MARK: - gm:// links

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "gm" {
            if url.host == "control" {
                switch url.path {
                case "/restart": restartServer()
                case "/stop": if startStopItem.title == "Stop Server" { toggleServer() }
                case "/start": if server == nil { recentExits = []; startServer() }
                default: break
                }
                continue
            }
            pendingURLs.append(url.absoluteString)
        }
        flushPendingURLs()
    }

    func flushPendingURLs() {
        if pendingURLs.isEmpty { return }
        whenUp { [weak self] in
            guard let self = self else { return }
            let urls = self.pendingURLs
            self.pendingURLs = []
            for u in urls { self.postCommand(u) }
        }
    }

    // The server parses gm:// URLs itself ({"url": "gm://map/..."}).
    func postCommand(_ gmURL: String) {
        guard let body = try? JSONSerialization.data(withJSONObject: ["url": gmURL]) else { return }
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(PORT)/api/command")!)
        req.httpMethod = "POST"
        req.httpBody = body
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        URLSession.shared.dataTask(with: req) { _, _, error in
            if let error = error { NSLog("gm:// post failed: \(error)") }
        }.resume()
    }

    // MARK: - helpers

    @discardableResult
    func sh(_ command: String) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", command]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }
}

// Only one of us. A second launch (Login Items plus a manual open, say) hands
// over to the first and quits, rather than starting a second server.
let me = Bundle.main.bundleIdentifier ?? "com.gm-display.app"
let others = NSRunningApplication.runningApplications(withBundleIdentifier: me)
    .filter { $0.processIdentifier != getpid() }
if !others.isEmpty {
    others.first?.activate(options: [])
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()

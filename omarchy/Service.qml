import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as ProtonDriveModel

// Headless poller for the engine that is already running. It never starts
// that process. The bar reads this object through the shell's own service.
Item {
  id: root
  visible: false

  property var shell: null
  property bool panelOpen: false
  property bool launcherOk: false
  property var doctor: null
  property var status: null
  property var conflicts: []
  property var quarantine: []
  property string setupError: ""
  property var queue: []
  property string pendingKind: ""

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string launcherPath: home + "/.local/bin/proton-drive-sync"
  readonly property var chip: ProtonDriveModel.chipModel({
    installed: launcherOk,
    doctor: doctor,
    status: status
  })

  function noteLauncher(body) {
    var text = String(body || "")
    root.launcherOk = text.indexOf("installed-by=io.github.zakkoo.proton-drive") !== -1 && text.indexOf("# runtime=") !== -1
    if (root.launcherOk) root.poll()
  }

  function parseJson(body) {
    try {
      return JSON.parse(String(body || ""))
    } catch (error) {
      return null
    }
  }

  function enqueue(args, kind) {
    if (!root.launcherOk) return
    var next = root.queue.slice()
    next.push({ args: args, kind: kind })
    root.queue = next
    root.pump()
  }

  function pump() {
    if (!root.launcherOk || cli.running || root.queue.length === 0) return
    var next = root.queue.slice()
    var job = next.shift()
    root.queue = next
    root.pendingKind = job.kind
    var cmd = [root.launcherPath]
    for (var i = 0; i < job.args.length; i++) cmd.push(String(job.args[i]))
    cli.command = cmd
    cli.running = true
  }

  function poll() {
    if (!root.launcherOk || cli.running || root.queue.length > 0) return
    root.enqueue(["doctor", "--json"], "doctor")
  }

  function handle(kind, code, out, err) {
    var parsed = root.parseJson(out)
    if (kind === "doctor") {
      if (code === 0 && parsed) root.doctor = parsed
      if (root.doctor && root.doctor.running === true) {
        root.enqueue(["status", "--json"], "status")
        root.enqueue(["conflicts", "--json"], "conflicts")
        root.enqueue(["quarantine", "--json"], "quarantine")
      } else if (code === 0) {
        root.status = null
        root.conflicts = []
        root.quarantine = []
      }
    } else if (kind === "status") {
      root.status = code === 0 && parsed && parsed.state ? parsed : null
    } else if (kind === "conflicts") {
      root.conflicts = code === 0 && parsed instanceof Array ? parsed : []
    } else if (kind === "quarantine") {
      root.quarantine = code === 0 && parsed instanceof Array ? parsed : []
    } else if (kind === "setup") {
      root.setupError = code === 0 ? "" : String(err || "Setup was refused").trim()
      root.enqueue(["doctor", "--json"], "doctor")
    } else if (code === 0 && parsed && parsed.state) {
      root.status = parsed
      root.enqueue(["doctor", "--json"], "doctor")
    }
    root.pump()
  }

  function pause() { root.enqueue(["pause", "--json"], "pause") }
  function resume() { root.enqueue(["resume", "--json"], "resume") }
  function syncNow() { root.enqueue(["sync-now", "--json"], "sync") }
  function confirmHeld(id) { root.enqueue(["held", "confirm", String(id), "--json"], "held") }
  function rejectHeld(id) { root.enqueue(["held", "reject", String(id), "--json"], "held") }
  function resolveConflict(id, choice) { root.enqueue(["conflicts", "resolve", String(id), String(choice), "--json"], "resolve") }
  function releaseQuarantine(id) { root.enqueue(["quarantine", "release", String(id), "--json"], "release") }

  function submitSetup(localPath, remotePath) {
    root.setupError = ""
    root.enqueue(["setup", String(localPath), String(remotePath)], "setup")
  }

  function signIn() {
    if (!root.launcherOk || signInProc.running) return
    signInProc.command = ["omarchy-launch-tui", root.launcherPath, "login"]
    signInProc.running = true
  }

  function openExternal(target) {
    if (!target || openProc.running) return
    openProc.command = ["xdg-open", String(target)]
    openProc.running = true
  }

  FileView {
    id: launcherFile
    path: root.launcherPath
    watchChanges: true
    printErrors: false
    onLoaded: root.noteLauncher(text())
    onLoadFailed: function(error) { root.noteLauncher("") }
  }

  Process {
    id: cli
    stdout: StdioCollector {
      id: cliOut
      waitForEnd: true
    }
    stderr: StdioCollector {
      id: cliErr
      waitForEnd: true
    }
    onExited: function(code) {
      root.handle(root.pendingKind, code, cliOut.text, cliErr.text)
    }
  }

  Process { id: signInProc }
  Process { id: openProc }

  Timer {
    interval: root.panelOpen || (root.status && (root.status.state === "syncing" || root.status.state === "scanning")) ? 2000 : 5000
    running: true
    repeat: true
    onTriggered: root.poll()
  }

  Component.onCompleted: launcherFile.reload()
}

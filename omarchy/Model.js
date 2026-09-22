// Pure presentation for the Proton Drive bar chip. Qt-free so vitest can
// evaluate it, and free of exports so Quickshell can import it as a script.

var LABELS = {
  not_installed: "Install",
  not_signed_in: "Sign in",
  not_configured: "Setup",
  not_running: "Off",
  starting: "Start",
  idle: "Drive",
  scanning: "Scan",
  syncing: "Sync",
  paused: "Paused",
  offline: "Offline",
  throttled: "Slow",
  attention: "Check",
  awaiting_confirmation: "Confirm",
  error: "Error",
  needs_login: "Sign in",
  stopped: "Stopped",
}

var TOOLTIPS = {
  not_installed: "Proton Drive engine is not installed",
  not_signed_in: "Sign in to Proton Drive",
  not_configured: "Choose the two folders to sync",
  not_running: "Proton Drive is not running",
  starting: "Proton Drive is starting",
  idle: "Proton Drive is in sync",
  scanning: "Proton Drive is scanning",
  syncing: "Proton Drive is syncing",
  paused: "Proton Drive is paused",
  offline: "Proton Drive is offline",
  throttled: "Proton Drive is waiting to retry",
  attention: "Proton Drive needs you",
  awaiting_confirmation: "Proton Drive is waiting for confirmation",
  error: "Proton Drive hit an error",
  needs_login: "Proton Drive needs you to sign in again",
  stopped: "Proton Drive has stopped",
}

function view(state, urgent) {
  return {
    state: state,
    urgent: urgent === true,
    label: LABELS[state] || "Drive",
    tooltip: TOOLTIPS[state] || "Proton Drive",
  }
}

function glance(status) {
  if (!status || !status.progress) return ""
  var total = Number(status.progress.total)
  var done = Number(status.progress.done)
  if (!(total > 0)) return ""
  if (status.state === "syncing") return "Sync (" + done + "/" + total + ")"
  if (status.state === "paused") return "Paused (" + done + "/" + total + ")"
  return ""
}

function userAttention(status) {
  var attention = status && status.attention ? status.attention : {}
  if (attention.heldPlan) return "awaiting_confirmation"
  if ((attention.conflicts || 0) > 0 || (attention.quarantined || 0) > 0) return "attention"
  return ""
}

function chipModel(input) {
  var source = input || {}
  if (source.installed !== true) return view("not_installed", false)
  var status = source.status
  if (status && typeof status.state === "string" && status.state.length > 0) {
    var override = userAttention(status)
    var state = override || status.state
    var urgent = state === "attention" || state === "awaiting_confirmation" || state === "error" || state === "needs_login"
    var base = view(state, urgent)
    if (override) return base
    var line = glance(status)
    if (line) return { state: state, urgent: urgent, label: line, tooltip: line }
    return base
  }
  var doctor = source.doctor
  if (!doctor) return view("starting", false)
  if (doctor.loggedIn !== true) return view("not_signed_in", true)
  if (doctor.configured !== true) return view("not_configured", false)
  return view("not_running", false)
}

function transferLine(transfer) {
  var item = transfer || {}
  var direction = item.kind === "upload" ? "↑ " : "↓ "
  var total = Number(item.total)
  var bytes = Number(item.bytes)
  var pct = total > 0 ? " " + String(Math.round((bytes / total) * 100)) + "%" : ""
  return direction + String(item.relPath || "") + pct
}

var ProtonDriveModel = {
  chipModel: chipModel,
  transferLine: transferLine,
}

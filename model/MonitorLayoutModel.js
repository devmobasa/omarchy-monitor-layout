// Monitor layout model. Loaded by both the QML panel and the Node test
// harness, so it must stay dependency-free.
//
// Omarchy runs Hyprland's Lua config provider: runtime changes go through
// `hyprctl eval 'hl.monitor({...})'` (verified in-use by Omarchy's own
// tools; `hyprctl keyword monitor` is not the house path), and durability
// comes from a flag file in the sourced toggles directory whose specs are
// keyed by EDID description (`desc:` selectors) — so each monitor's saved
// settings re-apply whenever that monitor is present, on any port.

var FLAG_BASENAME = "community-monitor-layout.lua"

function stateDir(xdgStateHome, home) {
  var base = typeof xdgStateHome === "string" && xdgStateHome.trim().length > 0
    ? xdgStateHome.trim()
    : String(home == null ? "" : home) + "/.local/state"
  return base + "/omarchy/toggles/hypr"
}

function flagPath(xdgStateHome, home) {
  return stateDir(xdgStateHome, home) + "/" + FLAG_BASENAME
}

function monitorsCommand() {
  return ["hyprctl", "-j", "monitors", "all"]
}

// Parse `hyprctl -j monitors all` into display records.
function parseMonitors(text) {
  var parsed = null
  if (typeof text === "string" && text.length > 0) {
    try { parsed = JSON.parse(text) } catch (error) { parsed = null }
  }
  if (!Array.isArray(parsed)) return []
  var monitors = []
  for (var i = 0; i < parsed.length; i++) {
    var m = parsed[i]
    if (!m || typeof m.name !== "string") continue
    monitors.push({
      name: m.name,
      description: typeof m.description === "string" ? m.description : "",
      disabled: m.disabled === true,
      width: Number(m.width) || 0,
      height: Number(m.height) || 0,
      refreshRate: Number(m.refreshRate) || 0,
      x: Number(m.x) || 0,
      y: Number(m.y) || 0,
      scale: Number(m.scale) || 1,
      transform: Number(m.transform) || 0,
      vrr: m.vrr === true,
      model: typeof m.model === "string" ? m.model : "",
      serial: typeof m.serial === "string" ? m.serial : "",
      availableModes: Array.isArray(m.availableModes) ? m.availableModes : []
    })
  }
  monitors.sort(function (a, b) { return a.name < b.name ? -1 : 1 })
  return monitors
}

// Logical (post-scale, post-transform) size, for the arrangement canvas.
function logicalSize(monitor) {
  var rotated = monitor.transform === 1 || monitor.transform === 3
    || monitor.transform === 5 || monitor.transform === 7
  var w = rotated ? monitor.height : monitor.width
  var h = rotated ? monitor.width : monitor.height
  var scale = monitor.scale > 0 ? monitor.scale : 1
  return { w: Math.round(w / scale), h: Math.round(h / scale) }
}

// ---- Lua building (sanitized: nothing unvalidated reaches eval) ------------

function luaString(value) {
  var text = String(value == null ? "" : value)
  if (/[^\x20-\x7e]/.test(text)) return null
  return '"' + text.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

function validMode(mode) {
  return /^\d{3,5}x\d{3,5}@\d{1,3}(\.\d+)?(Hz)?$/.test(String(mode == null ? "" : mode))
}

// Build one hl.monitor spec. `selector` is "name" (runtime apply to the
// connector) or "desc" (persistence keyed to the panel's EDID identity).
function monitorSpec(monitor, selectorKind) {
  var selector = selectorKind === "desc" && monitor.description.length > 0
    ? "desc:" + monitor.description : monitor.name
  var output = luaString(selector)
  if (output === null) return null
  if (monitor.disabled) {
    return "hl.monitor({ output = " + output + ", disabled = true })"
  }
  var mode = Math.round(monitor.width) + "x" + Math.round(monitor.height)
    + "@" + (Math.round(monitor.refreshRate * 100) / 100)
  if (!validMode(mode)) return null
  var x = Math.round(Number(monitor.x))
  var y = Math.round(Number(monitor.y))
  var scale = Math.round(Number(monitor.scale) * 100000) / 100000
  var transform = Math.round(Number(monitor.transform))
  if (!isFinite(x) || !isFinite(y) || !isFinite(scale) || scale <= 0 || scale > 4) return null
  if (transform < 0 || transform > 7) return null
  return "hl.monitor({ output = " + output
    + ", mode = " + luaString(mode)
    + ", position = " + luaString(x + "x" + y)
    + ", scale = " + scale
    + ", transform = " + transform
    + ", vrr = " + (monitor.vrr ? 1 : 0)
    + " })"
}

// Re-enabling keeps the existing rule's mode/position/scale (a disabled
// monitor's reported mode can be 0x0, which would fail validation).
function enableSpec(monitor) {
  var output = luaString(monitor.name)
  if (output === null) return null
  return "hl.monitor({ output = " + output + ", disabled = false })"
}

function applyCommand(monitor) {
  var spec = monitorSpec(monitor, "name")
  if (spec === null) return null
  return ["hyprctl", "eval", spec]
}

// Apply several monitors atomically in one eval, so a layout shift (e.g.
// after normalization) moves every affected monitor together. `enabling`
// is an optional list of names to re-enable with enableSpec instead.
function applyBatchCommand(monitors, enabling) {
  var specs = []
  for (var i = 0; i < (monitors ? monitors.length : 0); i++) {
    var m = monitors[i]
    var spec = enabling && enabling.indexOf(m.name) !== -1 ? enableSpec(m) : monitorSpec(m, "name")
    if (spec === null) return null
    specs.push(spec)
  }
  if (specs.length === 0) return null
  return ["hyprctl", "eval", specs.join("\n")]
}

// Monitors whose spec differs between two layouts (matched by name).
function changedMonitors(before, after) {
  var out = []
  for (var i = 0; i < after.length; i++) {
    var prev = null
    for (var j = 0; j < before.length; j++) if (before[j].name === after[i].name) prev = before[j]
    if (!prev || monitorSpec(prev, "name") !== monitorSpec(after[i], "name")) out.push(after[i])
  }
  return out
}

// ---- scale ---------------------------------------------------------------
// Same rule as Omarchy's monitor panel: a scale is clean when it divides the
// mode evenly (in 1/120 units); Hyprland otherwise substitutes its own.

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b)
  while (b) { var t = b; b = a % b; a = t }
  return a
}

function cleanScale(scale, width, height) {
  var requested = Number(scale)
  if (!(requested > 0) || !(width > 0) || !(height > 0)) return requested
  var divisor = gcd(Math.round(width * 120), Math.round(height * 120))
  var units = Math.round(requested * 120)
  if (units > divisor) units = divisor
  while (divisor % units !== 0) units++
  return Math.round(units / 120 * 100000) / 100000
}

var SCALE_PRESETS = [0.5, 0.75, 1, 1.25, 1.333333, 1.5, 1.6, 1.666667, 1.75, 2, 2.5, 3]

function scaleSteps(width, height) {
  var seen = {}
  var out = []
  for (var i = 0; i < SCALE_PRESETS.length; i++) {
    var s = cleanScale(SCALE_PRESETS[i], width, height)
    if (s > 0 && s <= 4 && !seen[s]) { seen[s] = true; out.push(s) }
  }
  out.sort(function (a, b) { return a - b })
  return out
}

function stepScale(current, width, height, direction) {
  var steps = scaleSteps(width, height)
  if (steps.length === 0) return current
  if (direction > 0) {
    for (var i = 0; i < steps.length; i++) if (steps[i] > current + 0.001) return steps[i]
    return steps[steps.length - 1]
  }
  for (var j = steps.length - 1; j >= 0; j--) if (steps[j] < current - 0.001) return steps[j]
  return steps[0]
}

function formatScale(scale) {
  return String(Math.round(Number(scale) * 100) / 100)
}

// The persistence flag: one desc-keyed spec per monitor; Hyprland ignores
// specs whose monitor is absent, which is exactly the auto-apply behavior.
function buildFlagContent(monitors) {
  var lines = [
    "-- Saved monitor layout (community.monitor-layout / Omarchy Nexus suite).",
    "-- Keyed by EDID description, so each monitor's settings re-apply",
    "-- whenever it is connected. Delete this file to forget the layout.",
    ""
  ]
  var wrote = 0
  for (var i = 0; i < (monitors ? monitors.length : 0); i++) {
    var spec = monitorSpec(monitors[i], "desc")
    if (spec !== null) {
      lines.push(spec)
      wrote += 1
    }
  }
  if (wrote === 0) return null
  lines.push("")
  return lines.join("\n")
}

// ---- arrangement canvas math ------------------------------------------------

function bounds(monitors) {
  var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (var i = 0; i < (monitors ? monitors.length : 0); i++) {
    var m = monitors[i]
    if (m.disabled) continue
    var size = logicalSize(m)
    b.minX = Math.min(b.minX, m.x); b.minY = Math.min(b.minY, m.y)
    b.maxX = Math.max(b.maxX, m.x + size.w); b.maxY = Math.max(b.maxY, m.y + size.h)
  }
  if (b.minX === Infinity) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return b
}

// Scale-to-fit factor for drawing monitor rects inside a canvas. Leaves
// room around the layout so a monitor can be dropped beside, above or below.
function canvasScale(monitors, canvasW, canvasH) {
  var b = bounds(monitors)
  var w = Math.max(1, b.maxX - b.minX)
  var h = Math.max(1, b.maxY - b.minY)
  return Math.min(canvasW / (w * 1.6), canvasH / (h * 1.6))
}

// Canvas offset (pixels) that centers the layout in the canvas.
function canvasOffset(monitors, canvasW, canvasH, drawScale) {
  var b = bounds(monitors)
  return {
    x: (canvasW - (b.maxX - b.minX) * drawScale) / 2 - b.minX * drawScale,
    y: (canvasH - (b.maxY - b.minY) * drawScale) / 2 - b.minY * drawScale
  }
}

function overlaps(a, sa, b, sb) {
  return a.x < b.x + sb.w && a.x + sa.w > b.x && a.y < b.y + sb.h && a.y + sa.h > b.y
}

// Snap a dropped monitor to its neighbours: edges abut (left↔right,
// top↔bottom), edges align (left/left, top/top, ...), and centers align, so
// "centered below" is one drag. `threshold` is in layout pixels. Any
// remaining overlap is pushed out along the shallower axis.
function snapToNeighbours(monitors, index, x, y, threshold) {
  var me = monitors[index]
  var size = logicalSize(me)
  var bestX = null, bestY = null, dx = threshold + 1, dy = threshold + 1
  for (var i = 0; i < monitors.length; i++) {
    var o = monitors[i]
    if (i === index || o.disabled) continue
    var os = logicalSize(o)
    var xs = [o.x + os.w, o.x - size.w, o.x, o.x + os.w - size.w, o.x + (os.w - size.w) / 2]
    var ys = [o.y + os.h, o.y - size.h, o.y, o.y + os.h - size.h, o.y + (os.h - size.h) / 2]
    for (var k = 0; k < xs.length; k++) {
      if (Math.abs(xs[k] - x) < dx) { dx = Math.abs(xs[k] - x); bestX = xs[k] }
      if (Math.abs(ys[k] - y) < dy) { dy = Math.abs(ys[k] - y); bestY = ys[k] }
    }
  }
  // Center on the rest of the layout as a group (e.g. under the seam of two
  // side-by-side monitors).
  var others = []
  for (var g = 0; g < monitors.length; g++) if (g !== index) others.push(monitors[g])
  if (others.length > 1) {
    var gb = bounds(others)
    var gx = gb.minX + (gb.maxX - gb.minX - size.w) / 2
    var gy = gb.minY + (gb.maxY - gb.minY - size.h) / 2
    if (Math.abs(gx - x) <= dx) { dx = Math.abs(gx - x); bestX = gx }
    if (Math.abs(gy - y) <= dy) { dy = Math.abs(gy - y); bestY = gy }
  }
  var p = { x: Math.round(bestX !== null ? bestX : x), y: Math.round(bestY !== null ? bestY : y) }

  for (var pass = 0; pass < monitors.length; pass++) {
    var moved = false
    for (var j = 0; j < monitors.length; j++) {
      var n = monitors[j]
      if (j === index || n.disabled) continue
      var ns = logicalSize(n)
      if (!overlaps(p, size, n, ns)) continue
      var pushes = [
        { x: n.x - size.w, y: p.y }, { x: n.x + ns.w, y: p.y },
        { x: p.x, y: n.y - size.h }, { x: p.x, y: n.y + ns.h }
      ]
      pushes.sort(function (a, b) {
        return (Math.abs(a.x - p.x) + Math.abs(a.y - p.y)) - (Math.abs(b.x - p.x) + Math.abs(b.y - p.y))
      })
      p = pushes[0]
      moved = true
    }
    if (!moved) break
  }
  return p
}

// When a monitor's logical size changes (scale, rotation, mode), shift the
// monitors that touched its right or bottom edge so they stay adjacent.
function reflowAfterResize(monitors, index, oldSize) {
  var me = monitors[index]
  var size = logicalSize(me)
  var dw = size.w - oldSize.w
  var dh = size.h - oldSize.h
  if (dw === 0 && dh === 0) return monitors
  var out = monitors.slice()
  for (var i = 0; i < out.length; i++) {
    var o = out[i]
    if (i === index || o.disabled) continue
    var changes = {}
    if (dw !== 0 && o.x >= me.x + oldSize.w) changes.x = o.x + dw
    if (dh !== 0 && o.y >= me.y + oldSize.h) changes.y = o.y + dh
    if (changes.x !== undefined || changes.y !== undefined) out[i] = mergeMonitor(o, changes)
  }
  return out
}

// Snap a dragged position and normalize so the layout origin stays 0,0.
function snap(value, grid) {
  var g = Number(grid) || 16
  return Math.round(Number(value) / g) * g
}

function normalizePositions(monitors) {
  var minX = Infinity
  var minY = Infinity
  var enabled = 0
  for (var i = 0; i < monitors.length; i++) {
    if (monitors[i].disabled) continue
    enabled += 1
    if (monitors[i].x < minX) minX = monitors[i].x
    if (monitors[i].y < minY) minY = monitors[i].y
  }
  if (enabled === 0 || (minX === 0 && minY === 0)) return monitors
  var out = []
  for (var j = 0; j < monitors.length; j++) {
    var m = monitors[j]
    out.push(m.disabled ? m : mergeMonitor(m, { x: m.x - minX, y: m.y - minY }))
  }
  return out
}

function mergeMonitor(monitor, changes) {
  var next = {}
  for (var key in monitor) next[key] = monitor[key]
  for (var change in changes) next[change] = changes[change]
  return next
}

// Parse an availableModes entry ("3840x2160@60.00Hz") for the mode picker.
function parseMode(text) {
  var match = /^(\d+)x(\d+)@(\d+(?:\.\d+)?)Hz$/.exec(String(text == null ? "" : text).trim())
  if (!match) return null
  return { width: Number(match[1]), height: Number(match[2]), refresh: Number(match[3]) }
}

if (typeof module !== "undefined") {
  module.exports = {
    FLAG_BASENAME: FLAG_BASENAME,
    stateDir: stateDir,
    flagPath: flagPath,
    monitorsCommand: monitorsCommand,
    parseMonitors: parseMonitors,
    logicalSize: logicalSize,
    luaString: luaString,
    validMode: validMode,
    monitorSpec: monitorSpec,
    applyCommand: applyCommand,
    enableSpec: enableSpec,
    applyBatchCommand: applyBatchCommand,
    changedMonitors: changedMonitors,
    cleanScale: cleanScale,
    scaleSteps: scaleSteps,
    stepScale: stepScale,
    formatScale: formatScale,
    bounds: bounds,
    canvasOffset: canvasOffset,
    snapToNeighbours: snapToNeighbours,
    reflowAfterResize: reflowAfterResize,
    buildFlagContent: buildFlagContent,
    canvasScale: canvasScale,
    snap: snap,
    normalizePositions: normalizePositions,
    mergeMonitor: mergeMonitor,
    parseMode: parseMode
  }
}

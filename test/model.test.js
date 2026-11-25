const assert = require('node:assert/strict')
const model = require('../model/MonitorLayoutModel.js')

const dell = {
  name: 'DP-1', description: 'Dell Inc. DELL U3219Q 9WTG413', disabled: false,
  width: 3840, height: 2160, refreshRate: 59.997, x: 2304, y: 0,
  scale: 1.67, transform: 0, vrr: false, availableModes: ['3840x2160@60.00Hz']
}

// ---- parsing ----------------------------------------------------------------

const parsed = model.parseMonitors(JSON.stringify([dell, { bogus: true }, null]))
assert.equal(parsed.length, 1)
assert.equal(parsed[0].name, 'DP-1')
assert.deepEqual(model.parseMonitors('junk'), [])

assert.deepEqual(model.parseMode('3840x2160@60.00Hz'), { width: 3840, height: 2160, refresh: 60 })
assert.equal(model.parseMode('nope'), null)

assert.deepEqual(model.logicalSize(dell), { w: 2299, h: 1293 })
assert.deepEqual(model.logicalSize(model.mergeMonitor(dell, { transform: 1 })),
  { w: 1293, h: 2299 }, 'rotation swaps the logical box')

// ---- Lua safety -------------------------------------------------------------

assert.equal(model.luaString('Dell "27"'), '"Dell \\"27\\""')
assert.equal(model.luaString('back\\slash'), '"back\\\\slash"')
assert.equal(model.luaString('evil\nname'), null, 'control characters never reach eval')

const spec = model.monitorSpec(dell, 'name')
assert.match(spec, /^hl\.monitor\(\{ output = "DP-1", mode = "3840x2160@60", position = "2304x0", scale = 1\.67, transform = 0, vrr = 0 \}\)$/)

const descSpec = model.monitorSpec(dell, 'desc')
assert.match(descSpec, /output = "desc:Dell Inc\. DELL U3219Q 9WTG413"/)

const disabledSpec = model.monitorSpec(model.mergeMonitor(dell, { disabled: true }), 'name')
assert.equal(disabledSpec, 'hl.monitor({ output = "DP-1", disabled = true })')

assert.equal(model.monitorSpec(model.mergeMonitor(dell, { scale: 99 }), 'name'), null,
  'absurd scales are rejected')
assert.equal(model.monitorSpec(model.mergeMonitor(dell, { name: 'DP\n1' }), 'name'), null)

assert.match(spec, /vrr = 0/, 'VRR off is explicit')
// (spec regex above updated)
const vrrSpec = model.monitorSpec(model.mergeMonitor(dell, { vrr: true }), 'name')
assert.match(vrrSpec, /vrr = 1/)

assert.deepEqual(model.applyCommand(dell).slice(0, 2), ['hyprctl', 'eval'])
assert.equal(model.applyCommand(model.mergeMonitor(dell, { transform: 9 })), null)

// ---- persistence flag -------------------------------------------------------

const flag = model.buildFlagContent([dell, model.mergeMonitor(dell, { name: 'HDMI-A-1', description: 'LG TV', x: 0 })])
assert.match(flag, /desc:Dell Inc/)
assert.match(flag, /desc:LG TV/)
assert.ok(flag.endsWith('\n'))
assert.equal(model.buildFlagContent([]), null, 'an empty layout writes nothing')

// ---- canvas math ------------------------------------------------------------

assert.equal(model.snap(1017, 16), 1024)
assert.equal(model.snap(-9, 16), -16)

const shifted = model.normalizePositions([
  model.mergeMonitor(dell, { x: 500, y: 200 }),
  model.mergeMonitor(dell, { name: 'DP-3', x: 2804, y: 200 })
])
assert.equal(shifted[0].x, 0, 'the layout origin normalizes to 0,0')
assert.equal(shifted[1].x, 2304)
assert.equal(shifted[0].y, 0)

const scale = model.canvasScale([dell], 600, 300)
assert.ok(scale > 0 && scale < 1)


// ---- batch apply / enable -------------------------------------------------

assert.equal(model.enableSpec(dell), 'hl.monitor({ output = "DP-1", disabled = false })')
const batch = model.applyBatchCommand([dell, model.mergeMonitor(dell, { name: 'DP-2', disabled: true })], ['DP-2'])
assert.deepEqual(batch.slice(0, 2), ['hyprctl', 'eval'])
assert.equal(batch[2].split('\n').length, 2)
assert.match(batch[2], /output = "DP-2", disabled = false/)
assert.equal(model.applyBatchCommand([model.mergeMonitor(dell, { scale: 99 })]), null)
assert.equal(model.changedMonitors([dell], [dell]).length, 0)
assert.equal(model.changedMonitors([dell], [model.mergeMonitor(dell, { x: 0 })]).length, 1)

// ---- scales ---------------------------------------------------------------

const fhd = model.scaleSteps(1920, 1080)
assert.ok(fhd.indexOf(1.5) !== -1 && fhd.indexOf(1.25) !== -1)
assert.ok(fhd.every(s => Number.isInteger(Math.round(1920 * 120) / Math.round(s * 120))), 'only clean scales')
assert.equal(model.stepScale(1, 1920, 1200, 1), 1.25)
assert.equal(model.stepScale(1.5, 1920, 1200, -1) < 1.5, true)

// ---- the "two on top, laptop centered below" layout -------------------------

const mk = (name, w, h, scale, x, y) => ({ name, description: name, disabled: false, width: w, height: h,
  refreshRate: 60, x, y, scale, transform: 0, vrr: false, availableModes: [] })
let layout = [
  mk('DP-7', 1920, 1080, 1, 1280, 0),
  mk('DP-8', 1920, 1080, 1, 3200, 0),
  mk('eDP-1', 1920, 1200, 1.5, 0, 128)   // logical 1280x800
]
// Drag the laptop roughly under the middle of the pair: center + bottom snap.
let p = model.snapToNeighbours(layout, 2, 2500, 1110, 120)
assert.deepEqual(p, { x: 1280 + (3840 - 1280) / 2, y: 1080 }, 'snaps flush below, centered on the pair')
layout = layout.slice(); layout[2] = model.mergeMonitor(layout[2], p)
layout = model.normalizePositions(layout)
assert.deepEqual(layout.map(m => [m.name, m.x, m.y]),
  [['DP-7', 0, 0], ['DP-8', 1920, 0], ['eDP-1', 1280, 1080]])

// A drop on top of another monitor is pushed out, never left overlapping.
const q = model.snapToNeighbours(layout, 2, 100, 100, 10)
const qs = model.logicalSize(layout[2])
for (const o of layout.slice(0, 2)) {
  const os = model.logicalSize(o)
  assert.ok(!(q.x < o.x + os.w && q.x + qs.w > o.x && q.y < o.y + os.h && q.y + qs.h > o.y))
}

// Negative drops are allowed; normalization shifts everyone back to 0,0.
let left = layout.slice(); left[2] = model.mergeMonitor(left[2], { x: -1280, y: 0 })
left = model.normalizePositions(left)
assert.equal(left[2].x, 0); assert.equal(left[0].x, 1280)
assert.equal(model.changedMonitors(layout, left).length, 3, 'all three must be applied')

// Resizing keeps right/bottom neighbours adjacent.
let resized = layout.slice(); const before = model.logicalSize(resized[0])
resized[0] = model.mergeMonitor(resized[0], { scale: 1.25 })
resized = model.reflowAfterResize(resized, 0, before)
assert.equal(resized[1].x, model.logicalSize(resized[0]).w)

console.log('ok - monitor layout model')

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

const manifest = JSON.parse(read('manifest.json'))
assert.equal(manifest.schemaVersion, 1)
assert.equal(manifest.id, 'community.monitor-layout')
assert.deepEqual(manifest.kinds, ['panel'])
assert.equal(manifest.entryPoints.panel, 'MonitorLayout.qml')
assert.match(read('LICENSE'), /MIT License/)

const panel = read('MonitorLayout.qml')

// Host lifecycle contract.
assert.match(panel, /^Item \{/m)
assert.match(panel, /function open\(payloadJson\)/)
assert.match(panel, /function close\(\)/)
assert.match(panel, /closingFromHost/)
assert.match(panel, /Qt\.Key_Escape/)

// Every change goes through the sanitized model builders — nothing
// unvalidated reaches hyprctl eval — and applies via the house Lua path.
assert.match(panel, /MonitorLayoutModel\.applyBatchCommand/)
assert.match(panel, /MonitorLayoutModel\.parseMonitors/)
assert.match(panel, /MonitorLayoutModel\.buildFlagContent/)
assert.match(panel, /MonitorLayoutModel\.normalizePositions/)
assert.match(panel, /MonitorLayoutModel\.snapToNeighbours/)
assert.match(panel, /MonitorLayoutModel\.changedMonitors/, 'every monitor a move touches is applied')
assert.match(panel, /pendingCommands/, 'applies are queued, never dropped')
assert.match(panel, /interactive: contentHeight > height/, 'the flickable never steals drags')
assert.match(panel, /if \(command === null\)/, 'rejected specs never run')
assert.doesNotMatch(panel, /keyword monitor/, 'never the keyword path under the Lua provider')

// Persistence is the EDID-keyed toggle flag; forget removes exactly it.
assert.match(panel, /command: \["mkdir", "-p", root\.flagDir\]/)
assert.match(panel, /command: \["rm", "-f", root\.flagFile\]/)
assert.match(panel, /watchChanges: true/)

// Safety rail: the last enabled monitor cannot be disabled.
assert.match(panel, /filter\(function \(m\) \{ return !m\.disabled \}\)\.length > 1/)

assert.equal((panel.match(/\bProcess\s*\{/g) || []).length, 4,
  'monitors query, apply, mkdir, rm — nothing else')
assert.doesNotMatch(panel, /execDetached|bash -c|sh -c/)
assert.doesNotMatch(panel, /#[0-9a-fA-F]{6}/)

console.log('ok - monitor layout contract')

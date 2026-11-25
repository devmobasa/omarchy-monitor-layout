import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import Quickshell.Hyprland
import qs.Commons
import qs.Ui
import "model/MonitorLayoutModel.js" as MonitorLayoutModel

// Visual monitor arranger for Omarchy: drag monitor rectangles to position
// them, cycle modes, step scale, rotate, toggle VRR or disable — every
// change applies instantly through `hyprctl eval hl.monitor(...)` (the
// house path under the Lua config provider). "Save layout" persists the
// arrangement keyed by EDID description into the sourced toggles directory,
// so each monitor's settings re-apply whenever it is connected — on any
// port, surviving reboots. "Forget" removes the file.
Item {
  id: root

  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null

  property bool opened: false
  property var targetScreen: null
  property bool closingFromHost: false

  property var monitors: []
  property bool applying: false
  property var pendingCommands: []
  property string layoutError: ""
  property bool layoutSaved: false

  readonly property string flagDir: MonitorLayoutModel.stateDir(
    Quickshell.env("XDG_STATE_HOME"), Quickshell.env("HOME"))
  readonly property string flagFile: MonitorLayoutModel.flagPath(
    Quickshell.env("XDG_STATE_HOME"), Quickshell.env("HOME"))

  function open(payloadJson) {
    root.targetScreen = targetScreenForOpen()
    root.layoutError = ""
    root.opened = true
    refreshMonitors()
    Qt.callLater(function () {
      if (root.opened) keyCatcher.forceActiveFocus()
    })
  }

  function close() {
    closingFromHost = true
    root.opened = false
    root.targetScreen = null
    closingFromHost = false
  }

  function requestClose() {
    if (closingFromHost) return
    if (shell && typeof shell.hide === "function")
      shell.hide(manifest && manifest.id ? manifest.id : "community.monitor-layout")
    else root.opened = false
  }

  function status() {
    return JSON.stringify({
      opened: root.opened,
      monitors: root.monitors.length,
      layoutSaved: root.layoutSaved,
      error: root.layoutError
    })
  }

  function targetScreenForOpen() {
    var screens = Quickshell.screens || []
    var focused = Hyprland.focusedMonitor
    for (var i = 0; i < screens.length; i++) {
      var monitor = Hyprland.monitorFor(screens[i])
      if (focused && monitor === focused) return screens[i]
      if (focused && String(screens[i].name || "") === String(focused.name || "")) return screens[i]
    }
    return screens.length > 0 ? screens[0] : null
  }

  // ---- data + apply chain --------------------------------------------------
  function refreshMonitors() {
    if (monitorsProcess.running) {
      monitorsProcess.refreshPending = true
      return
    }
    monitorsProcess.exitSeen = false
    monitorsProcess.running = true
  }

  // Commands run one at a time, in order; nothing is dropped when changes
  // arrive faster than hyprctl returns. The model refreshes once the queue
  // drains, so the UI never flips back to a half-applied state.
  function enqueue(command) {
    if (command === null) {
      layoutError = "invalid settings"
      root.refreshMonitors()
      return
    }
    layoutError = ""
    pendingCommands = pendingCommands.concat([command])
    pumpQueue()
  }

  function pumpQueue() {
    if (applyProcess.running || pendingCommands.length === 0) return
    var queue = pendingCommands.slice()
    applyProcess.command = queue.shift()
    pendingCommands = queue
    applyProcess.exitSeen = false
    applyProcess.running = true
  }

  function changeMonitor(index, changes) {
    if (index < 0 || index >= monitors.length) return
    var before = monitors
    var oldSize = MonitorLayoutModel.logicalSize(before[index])
    var next = before.slice()
    next[index] = MonitorLayoutModel.mergeMonitor(next[index], changes)
    next = MonitorLayoutModel.reflowAfterResize(next, index, oldSize)
    next = MonitorLayoutModel.normalizePositions(next)
    var changed = MonitorLayoutModel.changedMonitors(before, next)
    monitors = next
    if (changed.length === 0) return
    var enabling = changes.disabled === false ? [next[index].name] : []
    enqueue(MonitorLayoutModel.applyBatchCommand(changed, enabling))
  }

  // Drop handler: snap to neighbouring edges/centers, then apply every
  // monitor the move (and the origin normalization) touched.
  function moveMonitor(index, x, y, threshold) {
    var p = MonitorLayoutModel.snapToNeighbours(monitors, index, x, y, threshold)
    changeMonitor(index, { x: p.x, y: p.y })
  }

  function cycleMode(index, step) {
    var monitor = monitors[index]
    if (!monitor || monitor.availableModes.length === 0) return
    var current = -1
    for (var i = 0; i < monitor.availableModes.length; i++) {
      var mode = MonitorLayoutModel.parseMode(monitor.availableModes[i])
      if (mode && mode.width === monitor.width && mode.height === monitor.height
          && Math.abs(mode.refresh - monitor.refreshRate) < 1) {
        current = i
        break
      }
    }
    var nextIndex = (current + step + monitor.availableModes.length) % monitor.availableModes.length
    var picked = MonitorLayoutModel.parseMode(monitor.availableModes[nextIndex])
    if (picked) changeMonitor(index, { width: picked.width, height: picked.height, refreshRate: picked.refresh })
  }

  function saveLayout() {
    var content = MonitorLayoutModel.buildFlagContent(monitors)
    if (content === null) {
      layoutError = "nothing to save"
      return
    }
    mkdirProcess.exitSeen = false
    mkdirProcess.pendingContent = content
    mkdirProcess.running = true
  }

  function forgetLayout() {
    removeProcess.exitSeen = false
    removeProcess.running = true
  }

  Process {
    id: monitorsProcess
    property bool exitSeen: false
    property bool refreshPending: false
    command: MonitorLayoutModel.monitorsCommand()
    onRunningChanged: {
      if (running || !refreshPending) return
      refreshPending = false
      root.refreshMonitors()
    }

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        monitorsProcess.exitSeen = true
        // A pending apply will refresh again; don't show stale state meanwhile.
        if (applyProcess.running || root.pendingCommands.length > 0) return
        root.monitors = MonitorLayoutModel.parseMonitors(text)
      }
    }
  }

  Process {
    id: applyProcess
    property bool exitSeen: false
    command: ["hyprctl", "eval", "hl.no_op or true"]
    onRunningChanged: {
      if (running || exitSeen) return
      root.layoutError = "hyprctl could not be started"
      root.pendingCommands = []
      root.refreshMonitors()
    }
    onExited: function (exitCode) {
      exitSeen = true
      if (exitCode !== 0) root.layoutError = "apply failed"
      if (root.pendingCommands.length > 0) root.pumpQueue()
      else root.refreshMonitors()
    }
  }

  Process {
    id: mkdirProcess
    property bool exitSeen: false
    property string pendingContent: ""
    command: ["mkdir", "-p", root.flagDir]
    onExited: function (exitCode) {
      exitSeen = true
      if (exitCode === 0 && pendingContent !== "") flagWriter.setText(pendingContent)
      pendingContent = ""
    }
  }

  Process {
    id: removeProcess
    property bool exitSeen: false
    command: ["rm", "-f", root.flagFile]
    onExited: {
      exitSeen = true
      flagProbe.reload()
    }
  }

  FileView {
    id: flagWriter
    path: root.flagFile
    printErrors: false
    atomicWrites: true
    onSaved: {
      reload()
      flagProbe.reload()
    }
  }

  FileView {
    id: flagProbe
    path: root.flagFile
    printErrors: false
    watchChanges: true
    onLoaded: root.layoutSaved = true
    onLoadFailed: root.layoutSaved = false
    onFileChanged: reload()
  }

  Connections {
    target: Quickshell
    function onScreensChanged() {
      if (!root.opened) return
      root.refreshMonitors()
      var screens = Quickshell.screens || []
      if (!root.targetScreen || screens.indexOf(root.targetScreen) === -1) {
        root.targetScreen = root.targetScreenForOpen()
        if (!root.targetScreen) root.requestClose()
      }
    }
  }

  PanelWindow {
    id: panel
    visible: root.opened
    screen: root.targetScreen
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "omarchy-monitor-layout"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: root.opened ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: Color.menu.scrim
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.requestClose()
    }

    Item {
      id: keyCatcher
      anchors.fill: parent
      focus: true
      Keys.onPressed: function (event) {
        if (event.key === Qt.Key_Escape) {
          root.requestClose()
          event.accepted = true
        }
      }

      BorderSurface {
        anchors.centerIn: parent
        width: Math.min(Style.space(780), panel.width * 0.92)
        height: Math.min(layoutColumn.implicitHeight + Style.space(32), panel.height * 0.9)
        radius: Style.cornerRadius
        color: Color.menu.background
        borderSpec: Border.surfaceSpec("menu", "border", Color.menu.border, Math.max(1, Style.space(2)))

        MouseArea {
          anchors.fill: parent
          onClicked: {}
        }

        Flickable {
          anchors.fill: parent
          anchors.margins: Style.space(16)
          contentHeight: layoutColumn.implicitHeight
          clip: true
          // Only scroll when content overflows, so it never steals monitor drags.
          interactive: contentHeight > height
          boundsBehavior: Flickable.StopAtBounds

          Column {
            id: layoutColumn
            width: parent.width
            spacing: Style.spacing.md

            Item {
              width: parent.width
              height: titleText.implicitHeight

              Text {
                id: titleText
                text: "Monitor layout"
                color: Color.menu.text
                font.family: Style.font.family
                font.pixelSize: Style.font.heading
                font.bold: true
              }

              Row {
                anchors.right: parent.right
                spacing: Style.spacing.controlGap

                Button {
                  text: root.layoutSaved ? "Saved ✓ (update)" : "Save layout"
                  onClicked: root.saveLayout()
                }
                Button {
                  visible: root.layoutSaved
                  text: "Forget"
                  onClicked: root.forgetLayout()
                }
              }
            }

            Text {
              visible: root.layoutError !== ""
              width: parent.width
              text: root.layoutError
              color: Color.urgent
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }

            // ---- arrangement canvas -----------------------------------------
            Rectangle {
              id: canvas
              width: parent.width
              height: Style.space(280)
              radius: Style.cornerRadius
              color: Qt.rgba(Color.menu.text.r, Color.menu.text.g, Color.menu.text.b, 0.05)

              readonly property real drawScale: MonitorLayoutModel.canvasScale(
                root.monitors, width, height)
              readonly property var offset: MonitorLayoutModel.canvasOffset(
                root.monitors, width, height, drawScale)

              Repeater {
                model: root.monitors

                Rectangle {
                  id: monitorRect
                  required property var modelData
                  required property int index
                  visible: !modelData.disabled

                  readonly property var logical: MonitorLayoutModel.logicalSize(modelData)
                  width: Math.max(24, logical.w * canvas.drawScale)
                  height: Math.max(16, logical.h * canvas.drawScale)
                  x: canvas.offset.x + modelData.x * canvas.drawScale
                  y: canvas.offset.y + modelData.y * canvas.drawScale
                  z: rectDrag.active ? 1 : 0
                  radius: Style.cornerRadius / 2
                  color: rectDrag.active
                    ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.35)
                    : Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.18)
                  border.width: 1
                  border.color: Color.accent

                  Column {
                    anchors.centerIn: parent
                    width: parent.width - Style.space(8)

                    Text {
                      width: parent.width
                      horizontalAlignment: Text.AlignHCenter
                      textFormat: Text.PlainText
                      text: monitorRect.modelData.name
                      color: Color.menu.text
                      font.family: Style.font.family
                      font.pixelSize: Style.font.caption
                      font.bold: true
                      elide: Text.ElideRight
                    }
                    Text {
                      width: parent.width
                      horizontalAlignment: Text.AlignHCenter
                      textFormat: Text.PlainText
                      text: (monitorRect.modelData.model || monitorRect.modelData.description)
                        + (monitorRect.modelData.serial ? " · " + monitorRect.modelData.serial.slice(-4) : "")
                      color: Color.menu.text
                      opacity: 0.7
                      font.family: Style.font.family
                      font.pixelSize: Style.font.caption
                      elide: Text.ElideRight
                    }
                  }

                  DragHandler {
                    id: rectDrag
                    onActiveChanged: {
                      if (active) return
                      // Convert the dropped pixel position back to layout
                      // coordinates (negative is fine: normalization moves
                      // the whole layout back to origin 0,0), then snap to
                      // neighbours within ~16 canvas pixels.
                      var newX = (monitorRect.x - canvas.offset.x) / canvas.drawScale
                      var newY = (monitorRect.y - canvas.offset.y) / canvas.drawScale
                      root.moveMonitor(monitorRect.index, newX, newY, Style.space(16) / canvas.drawScale)
                    }
                  }
                }
              }
            }

            // ---- per-monitor controls ---------------------------------------
            Repeater {
              model: root.monitors

              Column {
                id: monitorRow
                required property var modelData
                required property int index
                width: parent.width
                spacing: Style.space(3)

                Text {
                  textFormat: Text.PlainText
                  text: monitorRow.modelData.name + " · " + monitorRow.modelData.description
                  width: parent.width
                  color: Color.menu.text
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  font.bold: true
                  elide: Text.ElideRight
                }

                Row {
                  spacing: Style.spacing.controlGap

                  Button {
                    iconText: "󰍽"
                    text: monitorRow.modelData.disabled ? "Off"
                      : monitorRow.modelData.width + "x" + monitorRow.modelData.height
                        + "@" + Math.round(monitorRow.modelData.refreshRate)
                    tooltipText: "Cycle mode (right-click backwards)"
                    enabled: !monitorRow.modelData.disabled
                    onClicked: root.cycleMode(monitorRow.index, 1)
                    onRightClicked: root.cycleMode(monitorRow.index, -1)
                  }

                  Button {
                    text: "scale " + MonitorLayoutModel.formatScale(monitorRow.modelData.scale)
                    tooltipText: "Click for the next valid scale up, right-click down"
                    enabled: !monitorRow.modelData.disabled
                    onClicked: root.changeMonitor(monitorRow.index, { scale: MonitorLayoutModel.stepScale(
                      monitorRow.modelData.scale, monitorRow.modelData.width, monitorRow.modelData.height, 1) })
                    onRightClicked: root.changeMonitor(monitorRow.index, { scale: MonitorLayoutModel.stepScale(
                      monitorRow.modelData.scale, monitorRow.modelData.width, monitorRow.modelData.height, -1) })
                  }

                  Button {
                    iconText: "󰑞"
                    text: ["0°", "90°", "180°", "270°"][monitorRow.modelData.transform % 4] || "0°"
                    enabled: !monitorRow.modelData.disabled
                    onClicked: root.changeMonitor(monitorRow.index,
                      { transform: (monitorRow.modelData.transform + 1) % 4 })
                  }

                  Button {
                    text: monitorRow.modelData.vrr ? "VRR on" : "VRR off"
                    active: monitorRow.modelData.vrr
                    enabled: !monitorRow.modelData.disabled
                    onClicked: root.changeMonitor(monitorRow.index,
                      { vrr: !monitorRow.modelData.vrr })
                  }

                  Button {
                    text: monitorRow.modelData.disabled ? "Enable" : "Disable"
                    enabled: monitorRow.modelData.disabled
                      || root.monitors.filter(function (m) { return !m.disabled }).length > 1
                    tooltipText: monitorRow.modelData.disabled ? ""
                      : "The last enabled monitor cannot be disabled"
                    onClicked: root.changeMonitor(monitorRow.index,
                      { disabled: !monitorRow.modelData.disabled })
                  }
                }
              }
            }

            Text {
              width: parent.width
              text: "Drag a monitor near another and it snaps edge-to-edge (or centered). Changes apply instantly. Save writes the layout keyed by monitor identity (EDID), so it re-applies whenever that monitor is connected — until you Forget it."
              color: Qt.darker(Color.menu.text, 1.5)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }
        }
      }
    }
  }
}

import QtQuick
import qs.Ui

BarWidget {
  id: root
  moduleName: "io.github.zakkoo.proton-drive"

  readonly property var sync: {
    var api = bar && bar.shell
    if (!api || typeof api.serviceFor !== "function") return null
    var found = api.serviceFor("io.github.zakkoo.proton-drive")
    return found || null
  }
  readonly property bool needsBuiltinBar: bar !== null && sync === null
  readonly property var chip: sync && sync.chip ? sync.chip : null

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() {
    if (panelLoader.item) panelLoader.item.open()
  }
  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }
  function toggle() {
    if (panelLoader.item) panelLoader.item.toggle()
  }
  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }
  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("service" in target) target.service = root.sync
    if ("needsBuiltinBar" in target) target.needsBuiltinBar = root.needsBuiltinBar
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSyncChanged: injectPanel()
  onNeedsBuiltinBarChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.needsBuiltinBar ? "Bar" : (root.chip ? root.chip.label : "Drive")
    tooltipText: root.needsBuiltinBar
      ? "Proton Drive needs the built-in Omarchy bar"
      : (root.chip ? root.chip.tooltip : "Proton Drive")
    foreground: root.bar ? (root.chip && root.chip.urgent ? root.bar.urgent : root.bar.barForeground) : "#e8e8e8"
    active: root.chip ? root.chip.urgent === true : false
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.LeftButton) root.toggle()
    }
  }
}

import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "Model.js" as ProtonDriveModel

Panel {
  id: root
  moduleName: "io.github.zakkoo.proton-drive"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var service: null
  property bool needsBuiltinBar: false
  property string localDraft: ""
  property string remoteDraft: ""

  readonly property var held: {
    var status = service && service.status
    var attention = status && status.attention
    return attention ? attention.heldPlan : null
  }
  readonly property var transfers: {
    var status = service && service.status
    return status && status.transfers ? status.transfers : []
  }
  readonly property string glance: {
    var status = service && service.status
    if (!status || !status.progress) return ""
    var total = Number(status.progress.total)
    var done = Number(status.progress.done)
    if (!(total > 0)) return ""
    if (status.state === "syncing") return "Sync (" + done + "/" + total + ")"
    if (status.state === "paused") return "Paused (" + done + "/" + total + ")"
    return ""
  }

  function open() { root.controller.show() }
  function close() { root.controller.hide() }
  function toggle() { root.opened ? root.close() : root.open() }
  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.hostWidget || root, direction)
    return false
  }

  onOpenedChanged: if (service) service.panelOpen = root.opened

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(320))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: content
        width: parent.width
        spacing: Style.space(8)

        Text {
          width: parent.width
          text: root.glance !== ""
            ? root.glance
            : (root.needsBuiltinBar || !root.service
              ? "Proton Drive needs the built-in Omarchy bar."
              : (root.service.chip ? root.service.chip.tooltip : "Proton Drive"))
          color: root.barForeground
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.subtitle
          font.bold: true
          wrapMode: Text.WordWrap
        }

        Text {
          visible: root.service && root.service.launcherOk !== true
          width: parent.width
          text: "Install the engine, then come back:\n~/.config/omarchy/plugins/io.github.zakkoo.proton-drive/scripts/install-engine --service"
          color: root.barForeground
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.body
          wrapMode: Text.WordWrap
        }

        Text {
          visible: root.service && root.service.launcherOk === true && root.service.chip && root.service.chip.state === "not_running"
          width: parent.width
          text: "The engine is not running. Start it with the user service from the install command above, or run proton-drive-sync in a terminal."
          color: root.barForeground
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.body
          wrapMode: Text.WordWrap
        }

        Column {
          visible: root.service && root.service.chip && root.service.chip.state === "not_signed_in"
          width: parent.width
          spacing: Style.space(6)
          Text {
            text: "Sign in"
            color: root.barForeground
            font.underline: true
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.body
            MouseArea {
              anchors.fill: parent
              onClicked: root.service.signIn()
            }
          }
        }

        Column {
          visible: root.service && root.service.chip && root.service.chip.state === "not_configured"
          width: parent.width
          spacing: Style.space(6)
          TextField {
            width: parent.width
            placeholderText: "Local folder"
            onTextEdited: root.localDraft = text
            color: root.barForeground
          }
          TextField {
            width: parent.width
            placeholderText: "Remote folder, like /my-files"
            onTextEdited: root.remoteDraft = text
            color: root.barForeground
          }
          Text {
            text: "Use these folders"
            color: root.barForeground
            font.underline: true
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.body
            MouseArea {
              anchors.fill: parent
              onClicked: root.service.submitSetup(root.localDraft, root.remoteDraft)
            }
          }
          Text {
            visible: root.service && root.service.setupError !== ""
            width: parent.width
            text: root.service ? root.service.setupError : ""
            color: root.bar ? root.bar.urgent : root.barForeground
            wrapMode: Text.WordWrap
            font.pixelSize: Style.font.bodySmall
          }
        }

        Repeater {
          model: root.transfers.length
          delegate: Text {
            required property int index
            width: content.width
            text: ProtonDriveModel.transferLine(root.transfers[index])
            color: root.barForeground
            font.pixelSize: Style.font.body
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
          }
        }

        Row {
          visible: root.service && root.service.status
          spacing: Style.space(12)
          Text {
            text: root.service && root.service.status && root.service.status.state === "paused" ? "Resume" : "Pause"
            color: root.barForeground
            font.underline: true
            font.pixelSize: Style.font.body
            MouseArea {
              anchors.fill: parent
              onClicked: {
                if (root.service.status && root.service.status.state === "paused") root.service.resume()
                else root.service.pause()
              }
            }
          }
          Text {
            text: "Sync now"
            color: root.barForeground
            font.underline: true
            font.pixelSize: Style.font.body
            MouseArea {
              anchors.fill: parent
              onClicked: root.service.syncNow()
            }
          }
        }

        Column {
          visible: root.held
          width: parent.width
          spacing: Style.space(4)
          Text {
            width: parent.width
            text: root.held ? ("Waiting: " + String(root.held.reason || "")) : ""
            color: root.barForeground
            wrapMode: Text.WordWrap
            font.pixelSize: Style.font.body
          }
          Repeater {
            model: root.held && root.held.affected ? root.held.affected.length : 0
            delegate: Text {
              required property int index
              width: content.width
              text: root.held ? String(root.held.affected[index]) : ""
              color: root.barForeground
              font.pixelSize: Style.font.bodySmall
            }
          }
          Row {
            spacing: Style.space(12)
            Text {
              text: "Confirm"
              color: root.barForeground
              font.underline: true
              font.pixelSize: Style.font.body
              MouseArea { anchors.fill: parent; onClicked: if (root.held) root.service.confirmHeld(root.held.id) }
            }
            Text {
              text: "Reject"
              color: root.barForeground
              font.underline: true
              font.pixelSize: Style.font.body
              MouseArea { anchors.fill: parent; onClicked: if (root.held) root.service.rejectHeld(root.held.id) }
            }
          }
        }

        Repeater {
          model: root.service && root.service.conflicts ? root.service.conflicts.length : 0
          delegate: Column {
            required property int index
            width: content.width
            spacing: Style.space(2)
            readonly property var row: root.service.conflicts[index]
            Text {
              width: parent.width
              text: row ? String(row.relPath || row.id) : ""
              color: root.barForeground
              font.pixelSize: Style.font.body
            }
            Row {
              spacing: Style.space(10)
              Text {
                text: "Keep local"
                font.underline: true
                color: root.barForeground
                font.pixelSize: Style.font.bodySmall
                MouseArea { anchors.fill: parent; onClicked: root.service.resolveConflict(row.id, "keep_local") }
              }
              Text {
                text: "Keep remote"
                font.underline: true
                color: root.barForeground
                font.pixelSize: Style.font.bodySmall
                MouseArea { anchors.fill: parent; onClicked: root.service.resolveConflict(row.id, "keep_remote") }
              }
              Text {
                text: "Keep both"
                font.underline: true
                color: root.barForeground
                font.pixelSize: Style.font.bodySmall
                MouseArea { anchors.fill: parent; onClicked: root.service.resolveConflict(row.id, "keep_both") }
              }
            }
          }
        }

        Repeater {
          model: root.service && root.service.quarantine ? root.service.quarantine.length : 0
          delegate: Row {
            required property int index
            width: content.width
            spacing: Style.space(8)
            readonly property var row: root.service.quarantine[index]
            Text {
              text: row ? String(row.relPath || row.nodeUid || row.id) : ""
              color: root.barForeground
              font.pixelSize: Style.font.bodySmall
            }
            Text {
              text: "Release"
              font.underline: true
              color: root.barForeground
              font.pixelSize: Style.font.bodySmall
              MouseArea { anchors.fill: parent; onClicked: root.service.releaseQuarantine(row.id) }
            }
          }
        }

        Row {
          visible: root.service && root.service.doctor && (root.service.doctor.localRoot || root.service.doctor.detailUrl)
          spacing: Style.space(12)
          Text {
            visible: root.service && root.service.doctor && root.service.doctor.localRoot
            text: "Open folder"
            color: root.barForeground
            font.underline: true
            font.pixelSize: Style.font.body
            MouseArea { anchors.fill: parent; onClicked: root.service.openExternal(root.service.doctor.localRoot) }
          }
          Text {
            visible: root.service && root.service.doctor && root.service.doctor.detailUrl
            text: "Open details"
            color: root.barForeground
            font.underline: true
            font.pixelSize: Style.font.body
            MouseArea { anchors.fill: parent; onClicked: root.service.openExternal(root.service.doctor.detailUrl) }
          }
        }
      }
    }
  }
}

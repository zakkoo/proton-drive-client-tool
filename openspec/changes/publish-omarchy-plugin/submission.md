### Repository URL

https://github.com/zakkoo/proton-drive-client-tool

### Category

Productivity

### Tags

bar, system, security

### Suggest a missing tag

_No response_

### Maintainer notes

Service plus bar widget for `io.github.zakkoo.proton-drive`. `omarchy plugin add` only copies the shell files. The Node engine is built only when the user runs `scripts/install-engine`. That command uses no sudo and does not pipe a download into a shell. An optional `--service` flag writes a user unit only when one is not already there, and starts `proton-drive-sync run --no-tray`. Removal does not delete the sync folder, the Proton session, or the tool's config.

The preview is the supplied Proton Drive card (`preview.png`). The owner must confirm they have permission to submit that image before this issue is opened. The repository is not anonymously visible yet and must be public before validation. This draft is not the submission.

### Submission checklist

- [ ] The repository is public and contains installation and removal instructions.
- [ ] I have documented the plugin license and any external dependencies.
- [ ] I confirm that I own or have permission to submit this plugin and its preview assets.
- [ ] The plugin does not overwrite user configuration without explicit consent.
- [ ] I understand that approval is for listing and is not a security review.

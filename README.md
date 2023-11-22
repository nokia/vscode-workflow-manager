# NOKIA Workflow Manager vsCode extension 

This vsCode extension connects to Nokia NSP WFM to facilitate workflow development and delivery.

## License

Copyright 2023 Nokia

Licensed under the BSD 3-Clause License.

SPDX-License-Identifier: BSD-3-Clause

Nokia logo is trademark of Nokia

## Features

The vsCode extension for NSP WFM allows a user to:

* Connect to a remote WFM.
* Download the full workflow and action list.
* Create new workflows and actions (with a predefined template).
* Modify and automatically upload workflow changes.
* Validate the format (requires RedHat's YAML extension).
* Retrieve the status from the latest execution.
* Access WFM with the right pointers to workflows and executions.
* Do all abovementioned actions on a local repository (local folder, git).


## Requirements

This package uses YAML, FETCH, vscode-URI and base-64 packages. For FETCH, it is importan to install 2.6.6 version. See other requirements in package.json.

## Install

To compile and generate the VSIX for installation, run:

    npm install .
    npm run compile
    vsce package

## Contribute

Contributions are welcome via normal pull request procedure.

## Extension Settings

To make the extension work, make sure you configure the following attributed in the extension configuration:

* `NSP IP address`: Ip address of the remote NSP server.
* `NSP user`: User name.
* `NSP password`: User's Password.
* `Allow local storage`: Enable the local storage of workflows when saving, to keep as backup.
* `Local storage folder`: Folder where workflows are copied, if the above flag is enabled.

## Known Issues

* Minor errors are reported by the vsCode. However, the extension runs without aparent issue. To be reviewed.
* First version. Will require deeper error control.
* `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` disbles SSL verification (not recommended).
* By changing the extension config, the data does not get updated. User needs to reload vsCode to get config updated.
* Local files are always treated as workflows. We need a mechanism to differentiate workflows from actions in local folders.
* In-line validation only works for workflows, not for actions (requires JSON schema for actions).

## TODOs

* Fix Know Issues. Review/Optimize code.

## Release Notes

See release changes in Changelog.

## Contributors

* [Alejandro Aguado](mailto:alejandro.aguado_martin@nokia.com)
* [Sven Wisotzky](mailto:sven.wisotzky@nokia.com)

## Important links

* [Developer portal](https://network.developer.nokia.com/learn/23_4/network-programmability-automation-frameworks/workflow-manager-framework/wfm-workflow-development/)


**Enjoy!**

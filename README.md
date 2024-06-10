# NOKIA Workflow Manager VsCode extension

This VsCode extension connects to Nokia NSP WFM to facilitate workflow development and delivery.

## License

Copyright 2023 Nokia

Licensed under the BSD 3-Clause License.

SPDX-License-Identifier: BSD-3-Clause

Nokia logo is trademark of Nokia

## Features
The vsCode extension for NSP WFM allows a user to:

* Connect to a remote WFM on any NSP.
* Download the full workflow, action, and jinja templates list.
* Create new workflows, actions, and templates (with a predefined template).
* Access and Edit WFM's workflow definitions, views, and documentations.
* Modify (CRUD operations) and automatically upload workflow changes to NSP.
* Validate the format (requires RedHat's YAML extension).
* Retrieve the status from the latest execution.
* Access WFM with the right pointers to workflows and executions.
* Do all above mentioned actions on a local repository (local folder, git).


## Requirements
This package uses YAML, FETCH, vscode-URI and base-64 packages. For FETCH, it is importan to install 2.6.6 version. See other requirements in package.json.

## Install
To compile and generate the VSIX for installation, run:

    npm install .
    npm run compile
    vsce package


## VsCode Extension Development
1. To compile the typescript extension run:

```bash
npm run compile
```

2. To run and open the live instance of the extension, open the VsCode Debugger and make sure you have extension.ts open in the VsCode editor.
    - ctrl+shift+p > Debug: Start Debugging >  VsCode Extension Development

3. After changes are made to the source code you  must recompile the extension in step 1. and then you must restart the extension devlopment host to reflect the changes:
    - ctrl+shift+F5
____

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
* Fix Known Issues. Review/Optimize code.

## Release Notes
See release changes in [CHANGELOG](./CHANGELOG.md)

## Contributors
* [Alejandro Aguado](mailto:alejandro.aguado_martin@nokia.com)
* [Sven Wisotzky](mailto:sven.wisotzky@nokia.com)
* [Abdulrahman Awad](mailto:abdulrahmansawad@gmail.com)


## Important links

* Nokia Network Developer Portal: [Developer portal](https://network.developer.nokia.com/learn/23_4/network-programmability-automation-frameworks/workflow-manager-framework/wfm-workflow-development/)
* VsCode Extension API: [VsCode API](https://code.visualstudio.com/api)

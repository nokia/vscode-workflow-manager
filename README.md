# NOKIA Workflow Manager VsCode extension

<p align="center">
    <img src="https://raw.githubusercontent.com/AbduAwad/vscode-workflow-manager/main/media/Nokia_WFM.png" width="250">
</p>


This VsCode extension connects to Nokia NSP WFM to facilitate and optimise workflow development and delivery within the VsCode IDE. A virtual filesystem is implemented so that your NSP Workflow Manager's workflows, actions, and tempates can be developed and delivered within the VsCode editor.

## License

Copyright 2024 Nokia

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
* Do all abovementioned actions on a local repository (local folder, git).
* Switch between different NSP endpoints and access different WFM instances.


## Requirements
This package uses YAML, FETCH, vscode-URI and base-64 packages. For FETCH, it is importan to install 2.6.6 version. See other requirements in package.json.


## Extension Settings and Usage

### Storage of Workflows to Local Filesystem

To allow local storage of workflows, you need to configure the following attributes in the VsCode workflowManager extension settings: 

**ctrl+shift+p > Preferences: Open Settings > Extensions > Workflow Manager**

* `Allow local storage`: Enable the local storage of workflows when saving, to keep as backup.
* `Local storage folder`: Folder where workflows are copied, if the above flag is enabled.
* `Ignore tags`: List of tags to be ignored by the plugin, to reduce the amount of workflows shown in the workflow list. When modified, the user will have to reload the vsCode window.
* `Timeout`: Connection timeout in milliseconds (default 20000).

### Connect to NSP WFM

To connect to an NSP WFM, you need to configure the following attributes in **workspace settings:**

**ctrl+shift+p > Preferences: Open Workspace Settings > Extensions > Workflow Manager**

* `NSP IP address`: Ip address of the remote NSP server.
* `NSP user`: User name.
* `NSP password`: User's Password.
* `NSP port`: Port to connect to the NSP server.


## Contribute

Contributions are welcome via normal pull request procedure.

## Run a live instance of the extension - VsCode Extension Development

1. To compile the typescript extension run:

```bash
npm run compile
```

2. To run and open the live instance of the extension, open the VsCode Debugger and make sure you have extension.ts open in the VsCode editor.

```bash
- ctrl+shift+p > Debug: Start Debugging >  VsCode Extension Development
```

3. After changes are made to the source code you  must recompile the extension in step 1. and then you must restart the extension devlopment host to reflect the changes:

```bash
- ctrl+shift+F5
```


## Build and install VSIX

Please make sure, you've got the following installed in your environment:

```
# npm install -g typescript
# npm install -g @vscode/vsce
```

Installation can be validated like this:

```
% npm list -g             
/usr/local/lib/node_modules/node/lib
├── @vscode/vsce@2.27.0
└── typescript@5.4.5
```

Before you compile and build the distribution, make sure all depended modules
are installed:

```
% npm install .
% npm list
nokia-intent-manager@2.1.1 ~/dev/vscode-intent-manager
├── @types/node@18.19.34
├── @types/vscode@1.90.0
├── @typescript-eslint/eslint-plugin@6.21.0
├── @typescript-eslint/parser@6.21.0
├── @vscode/codicons@0.0.36
├── base-64@1.0.0
├── esbuild@0.21.5
├── eslint@8.57.0
├── lodash@4.17.21
├── node-fetch@2.7.0
├── nunjucks@3.2.4
├── typescript@5.4.5
├── vscode-uri@3.0.8
├── vse@0.5.1
└── yaml@2.4.5
```

To see all dependencies, you can run `npm list --all`.
In cases of any issues, visit the `npm doctor`.

To compile and generate the VSIX for installation, run:
```bash
npm run compile
vsce package
```
To install the VSIX run:

```bash
code --install-extension <path-to-vsix-file>
```

_____


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
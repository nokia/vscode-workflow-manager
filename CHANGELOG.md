> # Change Log



## [0.0.1]

Initial release.

Features:
* Connect to a remote WFM.
* Download the full workflow and action list.
* Create new workflows and actions (with a predefined template).
* Modify and automatically upload workflow changes.
* Validate the format (requires RedHat's YAML extension).
* Retrieve the status from the latest execution.
* Access WFM with the right pointers to workflows and executions.
* Do all abovementioned actions on a local repository (local folder, git).

Issues:
* Minor errors are reported by the vsCode. However, the extension runs without aparent issue. To be reviewed.
* First version. Will require deeper error control.
* `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` disbles SSL verification (not recommended).
* By changing the extension config, the data does not get updated. User needs to reload vsCode to get config updated.
* Local files are always treated as workflows. We need a mechanism to differentiate workflows from actions in local folders.
* In-line validation only works for workflows, not for actions (requires JSON schema for actions).

Roadmap:
* Json-Schema for ad-hoc actions.
* File name ending. Shall we integrate ".yaml" when downloading?
* Support for Jinja templates.
* Running ad-hoc actions.

## [1.0.0]

Updates:
* Port is now configurable to connect to WS NOC WFM
* Handle disconnects from the system (timeouts)

## [1.0.1]

Updates:
* Allow users to configure connection timeouts (default 20 secs)

## [1.1.1]

Updates:
* For unsaved files, we add the compare functionality so the user can see all modifications before saving.
* In settings, the user can define a list of tags to be ignored by the plugin, to reduce the amount of workflows shown in the workflow list. When modified, the user will have to reload the vsCode window.

## [1.1.2]

Updates:
* Hide clear text password in settings.

## [1.1.3]

Updates:
* Removed all compile errors/warnings from source code.
* Added File Extensions to workflow and action files.
* Updated backend logic to proccess the extensions along with the filenames.
* tested functionality with filename extensions.
* files are downladed to the local filesystem with the file extension/type included.
* VsCode extension will only allow you to add/update/rename files with their correct extension.
    - .action for actions
    - .yaml for workflows

## [1.1.4]

Updates:
* Added support for jinja2 templates for the NSP WFM in the extension.
* Users can Create/Update/Delete/Rename templates. 
* Added File Extensions to jinja template files ".jinja".
* Template files are downladed to the local filesystem with the file extension/type included.
* Api call for GET/PUT/UPDATE are parsed so that unecessary metadata is not included in the jinja template file. Only the jinja template (Jinja Code), is what can be modified/read in the file.
* Error Checking: VsCode extension will only allow you to add/update/rename files using their correct respective extension.
    - .action for actions
    - .yaml for workflows
    - .jinja for templates


## [2.0.0]

**Updates:**
* Added support for workflow views and documentation.
* Users can read and update workflow views and documentations associated with a workflow.
* The Workflow folder structure has been modified so that each workflow in the workflow folder is a folder with the following scheme:
    - folder: workflow name
        - file: workflow name.json (workflow view)
        - file: workflow name.yaml  (workflow definition)
        - file: README.md (workflow documentation)
____

<p align="center">
    <img src="https://raw.githubusercontent.com/AbduAwad/vscode-workflow-manager/main/media/image.png" width="250" alt="Status bar showing current NSP server">
</p>

____

* Users can create a workflow by creating a new folder in the 'workflows' directory. Doing this will automatically generate the three workflow files for the workflow definition, view, and documentation.
* Renaming a workflow within its .yaml file definition will automatically create a copy of the workflow folder with the new name applied.
* All previous workflow .yaml functionality is still available with the new workflow folder structure, i.e. execute workflow, validate workflow, last execution result, open workflow in browser etc...

* Error Checking/Restrictions:
    - Users cannot delete any of the workflow files, as each of the files is associateed with the workflow. In order to delete a workflow and its associative files, the user must delete the associative workflow folder.
    - Users cannot rename any of the three workflow files as the name of the view, the definition, and the workflow folder must be the same. Renaming workflows is supported by renaming the associative workflow folder which will automatically rename the workflow files within that folder to match. 

_____

## [2.0.1]

**Updates:**

* Bug Fixes: 
    - Fixed issues with the generateSchema function and modified the wfm-schema-builder Jinja template to prevent red highlights/warnings in the workflow definitions if they are correct.
    - Workflow folder names containing dots (.) were causing unexpected behavior. Addressed the issue with workflow folder names containing dots. This fix allows workflow names to include dots without causing errors.
____
## [3.0.0] Multiple Server Support

### Select Server Support for Workspace
- Users can now connect to multiple NSP servers on different VsCode Windows.
- The current NSP server connection is displayed in the status bar. This connection is workspace-wide, allowing different VS Code workspaces/windows to connect to different NSP servers.
- The list of servers is stored in the user's VS Code extension settings, ensuring consistency across multiple windows/sessions (application-wide).

<p align="center">
    <img src="https://raw.githubusercontent.com/AbduAwad/vscode-workflow-manager/main/media/statusbar.png" width="450" alt="Status bar showing current NSP server">
</p>

### NOKIA_WFM and NOKIA_IM Extension Synchronized NSP Connection
- When a server is selected both the WFM and IM extensions connect to the same NSP on a given VS Code workspace (window).

<p align="center">
    <img src="https://raw.githubusercontent.com/AbduAwad/vscode-workflow-manager/main/media/multiServer.png" width="400" alt="Port selection for NSP connection">
</p>


### Server Selection
- Clicking the status bar opens a drop-down menu where users can select an NSP server to connect to. The list of servers is consistent across all VS Code windows and is consistent among both the WFM and IM extensions.

<p align="center">
    <img src="https://raw.githubusercontent.com/AbduAwad/vscode-workflow-manager/main/media/servers.png" width="550" alt="Drop-down menu for selecting NSP servers">
</p>


### Caching of NSP User/Password Credentials
- After selecting an NSP server, users are prompted to enter a username and password.
- If the credentials are valid and the connection is successful, the credentials are cached in VS Code Secret Storage.
- Cached credentials allow automatic reconnection without re-entering credentials.
- **Note:** Username and password are removed from settings and entered through the quick views, then stored in secret storage.

### NSP Credentials Error-Checking
- Incorrect credentials prompt an error message and a re-prompt to select a server.
- If the credentials don't connect to NSP, they are not cached.
- Authentication token failures also prompt an error message and a re-prompt to select a server.

### Adding NSP Servers
- Users can add NSP servers by clicking the '+' button in the quick view. This opens an input box for entering the IP address of the NSP server to add.

<p align="center">
    <img src="https://raw.githubusercontent.com/AbduAwad/vscode-workflow-manager/main/media/addServer.png" width="550" alt="Input box for adding NSP servers">
</p>

### Removing NSP Servers
- Users can remove NSP servers by clicking the '-' button in the quick view. This removes the selected NSP server from the list.

<p align="center">
    <img src="https://raw.githubusercontent.com/AbduAwad/vscode-workflow-manager/main/media/removeServer.png" width="550" alt="Option to remove NSP servers">
</p>

### Reset Connection Details for a Server
- Users can reset the credentials for an IP they are connected to by clicking the settings icon. These credentials are:
    - Username
    - Password
    - Port

<p align="center">
    <img src="https://raw.githubusercontent.com/AbduAwad/vscode-workflow-manager/main/media/resetCredentials.png" width="550" alt="Option to reset credentials">
</p>

### Set Ports: 

- When an NSP is selected from the dropdown, VS Code prompts the user to choose between a standard port and a non-standard port.

- If yes is selected (standard port), the NSP connection for NOKIA_WFM and NOKIA_IM will use the standard port, and the extensions will be set to no port.


<p align="center">
    <img src="https://raw.githubusercontent.com/AbduAwad/vscode-workflow-manager/main/media/port.png" width="550" alt="Port selection for NSP connection">
</p>

  - If no is selected, the user will be prompted to enter a port for the NOKIA_WFM and the NOKIA_IM NSP connections.

<p align="center">
    <img src="https://raw.githubusercontent.com/AbduAwad/vscode-workflow-manager/main/media/IM_PORT.png" width="550" alt="Port selection for NSP connection">
</p>

<p align="center">
    <img src="https://raw.githubusercontent.com/AbduAwad/vscode-workflow-manager/main/media/WFM_PORT.png" width="550" alt="Port selection for NSP connection">
</p>

- Users will only need to enter the port once. Once a port is entered that port is associated with that NSP, so in subsequent connections, users will not need to enter the port again.

- If a user enters an incorrect port they can reset connection details as observed in (Reset Connection Details for a Server) link: [Reset Connection Details for a Server](#reset-connection-details-for-a-server)

### Logging to VsCode Output Channel

* Logging for workflow manager operations using output channels of vscode. Logs are cleaned up and use the correct severity.
* Moved plugin logging to log output channel of vscode (not console.log/warn/error anymore).
  * Setup loglevel as desired from UI.
  * Logging is available in normal production environment (no need to debug the plugin).

<p align="center">
    <img src="https://raw.githubusercontent.com/AbduAwad/vscode-workflow-manager/main/media/loggingSelection.png" width="850">
</p>

<p align="center">
    <img src="https://raw.githubusercontent.com/AbduAwad/vscode-workflow-manager/main/media/logging.png" width="850">
</p>
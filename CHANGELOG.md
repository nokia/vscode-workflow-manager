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

## [2.0.2] 


### UI/UX Improvements 

- Workspace entry Workflow Manager tooltip include details when not connected / connection errors to replace error dialogue. Results in better user experience, especially when multiple NSP extensions are installed.
- Show NSP version as {major}.{minor}. With this "24.4.0" is displayed now as "24.4".
- OSD version is retrieved and displayed.

<p align="center">
    <img src="https://raw.githubusercontent.com/AbduAwad/vscode-workflow-manager/main/media/folderEnhancements.png" width="450" height='auto'>
</p>

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


### Alignment with Intent Manager

- getAuthToken() is now preformed in callNSP so it has been removed from all functions previously calling it to make NSP API calls.
- As outlined above there is no more console logging in the plugin. All logging is done through the log output channel of vscode.

### Settings have been moved to workspace settings rather than global user settings.

- To allow for multi-server support, the active nsp Server, the port, and connection details has been moved to workspace settings: (window scope instead of application scope). This allows for different workspaces to connect to different NSP servers.

### Implemented a command function nokia-wfm.connect (Provides support for NSP-Connect extension):

- The command can be called by other extensions (NSP-connect - not released yet) to connect to the NSP server using certain credentials specified by the NSP-connect extension.
- This does no affect the current functionality of the WFM extension.
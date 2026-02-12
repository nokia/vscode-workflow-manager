import * as vscode from 'vscode';
import { WorkflowManagerProvider } from './WorkflowManagerProvider';


let testLogs = vscode.window.createOutputChannel('WFM Validate Logs', {log: true});


let YAML = require("yaml");

export class ActionsProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'workflowManager.actionsView';

	private _view?: vscode.WebviewView;
	private _nspProvider: WorkflowManagerProvider;

	escapeHtml(string: String): String {
        return string
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
      }

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private nspProvider: WorkflowManagerProvider
	) {
		this._nspProvider = nspProvider;
	}

	public async resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [
				this._extensionUri
			]
		};

		webviewView.webview.html = await this._getHtmlForWebview(webviewView.webview);

		webviewView.webview.onDidReceiveMessage( async data => {
			switch (data.type) {
				case 'action':
					{
						let inputdata = YAML.parse(data.payload);
						if (["nsp.python", "std.javascript"].includes(data.action)) {
							if (data.context && data.context.trim() !== "") {
								try {
									inputdata["context"] = JSON.parse(data.context);
								} catch (e) {
									try {
										inputdata["context"] = YAML.parse(data.context);
									} catch (e) {
										vscode.window.showErrorMessage("Context data is not valid JSON or YAML.");
										return;
									}
								}
							} else {
								inputdata["context"] = "";
							}
						}
						let response = await this.nspProvider.actionExecute(data.action,inputdata);
						testLogs.clear();
						testLogs.show(true);
						testLogs.info(`Action result: ${data.action}`);
						testLogs.info(`Action Response:\n`+YAML.stringify(response["response"]["data"][0]["output"]["result"],{lineWidth:0})+`\n`);
						break;
					}
				case 'addtoworkflow':
					{
						const uri = vscode.window.activeTextEditor?.document.uri.toString();
						if (!uri || !uri.startsWith("wfm:/workflows/") || !uri.endsWith(".yaml")) {
							vscode.window.showErrorMessage("The active editor is not a workflow in WFM.");
							return;
						}
						let workflowdef = YAML.parse(vscode.window.activeTextEditor?.document.getText())
						let key = Object.keys(workflowdef).filter((value) => value !== "version")[0];
						let wftasks = Object.keys(workflowdef[key]["tasks"]).reverse();
						let taskName = await vscode.window.showInputBox({
										title: "Enter the task name",
										prompt: "Must be unique",
										value: "myNewTask"
						});
						
						if (wftasks.includes(taskName)){
							vscode.window.showErrorMessage("Task name already exists in the workflow.");
							return;
						}
						
						let taskconnect = await vscode.window.showQuickPick(wftasks, {title: "Pick a task to connect to", placeHolder: wftasks[0]});

						if (!taskconnect){
							vscode.window.showErrorMessage("Need to pick a valid task.");
							return;	
						}

						let condition = await vscode.window.showQuickPick(["on-success","on-complete","on-error"], {title: "Pick a condition", placeHolder: "on-complete"});

						if (!condition){
							vscode.window.showErrorMessage("Not selected a valid option.");
							return;	
						}

						workflowdef[key]["tasks"][taskName] = {
							"action": data.action,
							"input": YAML.parse(data.payload)
						};

						if (workflowdef[key]["tasks"][taskconnect].hasOwnProperty(condition)) {
							if (workflowdef[key]["tasks"][taskconnect][condition] instanceof Array) {
								workflowdef[key]["tasks"][taskconnect][condition].push(taskName);
							} else {
								workflowdef[key]["tasks"][taskconnect][condition] = [workflowdef[key]["tasks"][taskconnect][condition], taskName];
							}
						} else {
							workflowdef[key]["tasks"][taskconnect][condition] = [taskName];
						}

						const editor = vscode.window.activeTextEditor;
						if (editor) {
							var firstLine = editor.document.lineAt(0);
							var lastLine = editor.document.lineAt(editor.document.lineCount - 1);
							var textRange = new vscode.Range(firstLine.range.start, lastLine.range.end);
							editor.edit(editBuilder => {
								editBuilder.replace( textRange, YAML.stringify(workflowdef, {lineWidth: 0}).replace(
  									/(\n)( {4}[A-Za-z0-9_-]+:\n)/g,
  									'\n$1$2'
								).replace(
  									/(\n)( {2}tasks:\n)(\n)/g,
  									'\n$1$2'
								));
							});
						}
						

						break;
					}
			}
		});
	}


	private async _getHtmlForWebview(webview: vscode.Webview) {


		// Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'views', 'main.js'));

		// Do the same for the stylesheet.
		const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'views', 'reset.css'));
		const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'views', 'vscode.css'));
		const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'views', 'main.css'));

		// Use a nonce to only allow a specific script to be run.
		const nonce = getNonce();

		// from the below html returned by the funcion I need to remove the UL element and add instead a dropdown select and a text input following the vsCode webview example structure and style.

		let ret = `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
					Use a content security policy to only allow loading styles from our extension directory,
					and only allow scripts that have a specific nonce.
					(See the 'webview-sample' extension sample for img-src content security policy examples)
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${styleResetUri}" rel="stylesheet">
				<link href="${styleVSCodeUri}" rel="stylesheet">
				<link href="${styleMainUri}" rel="stylesheet">

				<title>Cat Colors</title>
			</head>
			<body>
				<select class="color-select" id="selector" onchange="logValue()">
					<option disabled selected value> -- select an action -- </option>`
		if (Object.keys(this.nspProvider.wfmactions).length === 0) {
			await this.nspProvider.generateSchema();
		}
		for (const key in this.nspProvider.wfmactions) {
			let example: String = "";
			try {
				example = this.escapeHtml(YAML.stringify(Object.values(YAML.parse(this.nspProvider.wfmactions[key].body[0]))[0]["input"]));
			} catch (error) {
				example = "";
			}
			ret = ret + `<option value="`+key+`" snippet="`+example+`">`+key+`</option>`;
		}
		ret = ret + `
				</select>
				<textarea cols="7" class="color-ta" id="actioninputs" placeholder="Enter action attributes"></textarea>
				<textarea cols="7" class="context-ta" id="contextdata" placeholder="Enter context data (YAML / JSON)"></textarea>
				<button class="try-action-button" id="tryAction">Try out</button>
				<button class="add-to-definition" id="addAction">Add to workflow</button>
				<a href="https://network.developer.nokia.com/learn/25_8/artifact-development/programming/workflows/wfm-workflow-development/wfm-workflow-actions/">See action documentation</a>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
		return ret;
	}
}


export class YaqlProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'workflowManager.yaqlView';

	private _view?: vscode.WebviewView;
	private _nspProvider: WorkflowManagerProvider;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private nspProvider: WorkflowManagerProvider
	) {
		this._nspProvider = nspProvider;
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [
				this._extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		webviewView.webview.onDidReceiveMessage( async data => {
			switch (data.type) {
				case 'yaql':
					{
						let payload = {};
						if (data.context || data.context.trim() !== "") {
							try {
								payload = JSON.parse(data.context);
							} catch (e) {
								try {
									payload = YAML.parse(data.context);
								} catch (e) {
									vscode.window.showErrorMessage("Context data is not valid JSON or YAML.");
									return;
								}
							}
						}
						let response = await this.nspProvider.actionExecute('nsp.yaql_eval',{ "context": payload,"expression": data.expression});
						testLogs.clear();
						testLogs.show(true);
						testLogs.info(`YAQL Expression: ${data.expression}`);
						testLogs.info(`YAQL Response:\n`+YAML.stringify(response["response"]["data"][0]["output"]["result"],{lineWidth:0})+`\n`);
						break;
					}
			}
		});
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		// Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'views', 'main.js'));

		// Do the same for the stylesheet.
		const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'views', 'reset.css'));
		const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'views', 'vscode.css'));
		const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'views', 'main.css'));

		// Use a nonce to only allow a specific script to be run.
		const nonce = getNonce();

		// from the below html returned by the funcion I need to remove the UL element and add instead a dropdown select and a text input following the vsCode webview example structure and style.

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
					Use a content security policy to only allow loading styles from our extension directory,
					and only allow scripts that have a specific nonce.
					(See the 'webview-sample' extension sample for img-src content security policy examples)
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${styleResetUri}" rel="stylesheet">
				<link href="${styleVSCodeUri}" rel="stylesheet">
				<link href="${styleMainUri}" rel="stylesheet">

				<title>Cat Colors</title>
			</head>
			<body>
				
				<input type="text" class="yaql-input" id="yaqlexpression" placeholder="Enter YAQL expression"/>
				<textarea cols="7" class="yaql-ta" id="contextdatayq" placeholder="Enter context data (YAML / JSON)"></textarea>

				<button class="try-yaql-button" id="sendYaql">Try out</button>

				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}
}


function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

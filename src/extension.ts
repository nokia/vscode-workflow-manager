/**
 * Copyright 2023 Nokia
 * Licensed under the BSD 3-Clause License.
 * SPDX-License-Identifier: BSD-3-Clause
*/

'use strict';

import * as vscode from 'vscode'; // import the vscode module (VS Code API)
import * as os from 'os'; //  import operating system
import * as fs from 'fs'; // import filesystem

// WorkflowManagerProvider is a class that contains all workflow operations.
import { WorkflowManagerProvider, CodelensProvider } from './providers'; 

// This function is ran once the the extension is activated:
export function activate(context: vscode.ExtensionContext) {  

	const secretStorage: vscode.SecretStorage = context.secrets;
	const config = vscode.workspace.getConfiguration('workflowManager'); // Gets the configuration settings from the settings.json file
	const server : string   = config.get("NSPIP")   ?? "";
	const username : string = config.get("user") ?? "";
	const port : string = config.get("port") ?? "";
	const timeout : number = config.get("timeout") ?? 90;
	const localsave : boolean = config.get("localStorage.enable") ?? false;
	const localpath : string = config.get("localStorage.folder") ?? "";
	const fileIgnore : Array<string> = config.get("ignoreTags") ?? [];
	const bestPracticesDiagnostics = vscode.languages.createDiagnosticCollection('[WFM]: bestPractices: ' + "https://network.developer.nokia.com/learn/24_4/network-programmability-automation-frameworks/workflow-manager-framework/wfm-workflow-development/wfm-best-practices/");

	const wfmProvider = new WorkflowManagerProvider(server, username, secretStorage, port, localsave, localpath, timeout, fileIgnore);
	
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider('wfm', wfmProvider, { isCaseSensitive: true }));
	context.subscriptions.push(vscode.window.registerFileDecorationProvider(wfmProvider));
	wfmProvider.extContext=context;
	
	const header = new CodelensProvider(server); 
	context.subscriptions.push(vscode.languages.registerCodeLensProvider({language: 'yaml', scheme: 'wfm'}, header));
	context.subscriptions.push(vscode.languages.registerCodeLensProvider({language: 'jinja', scheme: 'wfm'}, header));

	// // PUBLISHING COMMANDS
	// // --- A handler for the 'nokia-wfm.validate' command when the user clicks the checkmark
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.validate', async () => {
		wfmProvider.validate(); // validate an action, workflow, or template.
	}));

	// // --- A handler to Open workflow in Workflow Manager (Webbrowser) when the user clicks the link
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.openInBrowser', async () => {
		wfmProvider.openInBrowser();
	}));

	// // --- A handler to Apply schema for validation when the schema is not applied
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.applySchema', async () => {
		wfmProvider.applySchema();
	}));

	// --- A handler to Execute workflow in Workflow Manager when the user clicks the play button
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.execute', async () => {
		wfmProvider.execute();
	}));

	// // --- Get last execution result - when the user clicks the eye button
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.lastResult', async () => {
		wfmProvider.lastResult();
	}));

	// // --- Upload workflow from local file-system when 
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.upload', async () => {
		wfmProvider.upload();
	}));

	// generate input form for workflow view
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.generateForm', async () => {
		wfmProvider.generateForm();
	}));

	// // --- A handler to Test/Execute a Jinja Template when the user clicks the test button
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.testTemplate', async () => {
		wfmProvider.testTemplate();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.yaqalator', async () => {
		wfmProvider.yaqalator();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.runBestPractices', async () => {
		wfmProvider.runBestPractices(bestPracticesDiagnostics);
	}));

	// // Generate schema for validation
	wfmProvider.generateSchema();

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
		if (e.affectsConfiguration('workflowManager')) {
			wfmProvider.updateSettings(); // config has changed
		}
	}));

	// Apply YAML language to all wfm:/actions/* and wfm:/workflows/* files
	let fileAssociations : {string: string} = vscode.workspace.getConfiguration('files').get('associations') || <{string: string}>{};
    fileAssociations["/actions/*"] = "yaml"; // apply YAML language to all wfm:/actions/* files
	fileAssociations["/templates/*"] = "jinja"; // apply YAML language to all wfm:/templates/* files - Needed so that icons can show up for templates
    fileAssociations["/workflows/*"] = "yaml"; // apply YAML language to all wfm:/workflows/* files
	vscode.workspace.getConfiguration('files').update('associations', fileAssociations);

	// --- WORKFLOW EXAMPLES - When we click the bottom cloud button the nsp-workflow repo
	// is cloned to the workspace-
	// Add workflow examples to workspace (Bottom Cloud Button)
	const statusbar_examples = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 91);
	statusbar_examples.command = 'nokia-wfm.examples';
	statusbar_examples.tooltip = 'Add workflow examples to workspace';
	statusbar_examples.text = '$(cloud-download)';
	statusbar_examples.hide();

	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.examples', async () => {
		let gitPath = vscode.workspace.getConfiguration('git').get<string>('defaultCloneDirectory') || os.homedir();
		gitPath = gitPath.replace(/^~/, os.homedir());
		const gitUri = vscode.Uri.parse('file://'+gitPath);
		const repoUri = vscode.Uri.joinPath(gitUri, 'nsp-workflow');

		if (fs.existsSync(repoUri.fsPath)) {
			vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, { uri: repoUri});
		} else {
			vscode.commands.executeCommand('git.clone', 'https://github.com/nokia/nsp-workflow.git', gitPath);
		}
	}));

	// Set Password for WFM
	vscode.commands.registerCommand('nokia-wfm.setPassword', async () => {
		const passwordInput: string = await vscode.window.showInputBox({
			password: true, 
			title: "Password"
		}) ?? '';
		if(passwordInput !== ''){
			secretStorage.store("nsp_wfm_password", passwordInput);
		};
		wfmProvider.updateSettings(); // config has changed
	});

	vscode.commands.registerCommand('nokia-wfm.connect', async (username: string|undefined, password: string|undefined, nspAddr: string|undefined, port: string) => {
		const config = vscode.workspace.getConfiguration('workflowManager');
		if (username === undefined) {
			username = await vscode.window.showInputBox({title: "Username"});
		}
		if (username !== undefined) {
			config.update("user", username, vscode.ConfigurationTarget.Workspace);
		}
		if (password === undefined) {
			password = await vscode.window.showInputBox({password: true, title: "Password"});
		} else {
			secretStorage.store("nsp_wfm_password", password);
		}
		config.update("port", port, vscode.ConfigurationTarget.Workspace);
		config.update("NSPIP", nspAddr, vscode.ConfigurationTarget.Workspace);
	});

	
	// checks if the workspace folder is nsp-workflow and hides the examples button
	vscode.workspace.onDidChangeWorkspaceFolders(async () => {
		const workspaceFolders =  vscode.workspace.workspaceFolders ?  vscode.workspace.workspaceFolders : [];
		if (workspaceFolders.find( ({name}) => name === 'nsp-workflow')) {
			statusbar_examples.hide();
		} else {
			statusbar_examples.show();
		}	
	});

	const workspaceFolders =  vscode.workspace.workspaceFolders ?  vscode.workspace.workspaceFolders : [];
	if (!(workspaceFolders.find( ({name}) => name === 'nsp-workflow'))) {
		statusbar_examples.show();
	}

	// Add Workflow Manager folder to workspace
	vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, { uri: vscode.Uri.parse('wfm:/'), name: "Workflow Manager" });
}
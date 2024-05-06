/**
 * Copyright 2023 Nokia
 * Licensed under the BSD 3-Clause License.
 * SPDX-License-Identifier: BSD-3-Clause
 */

'use strict'; // 

import * as vscode from 'vscode'; // import the vscode module (VS Code API)
import * as os from 'os'; //  import operating system
import * as fs from 'fs'; // import filesystem

// WorkflowManagerProvider is a class that contains all workflow operations.
import { WorkflowManagerProvider, CodelensProvider } from './providers'; 

// This function is ran once the the extension is activated:
export function activate(context: vscode.ExtensionContext) {  
	console.log('Workflow Manager says "Hello"');

	const secretStorage: vscode.SecretStorage = context.secrets;
	const config = vscode.workspace.getConfiguration('workflowManager');
	const server : string   = config.get("server")   ?? "";
	const username : string = config.get("username") ?? "";
	const port : string = config.get("port") ?? "";
	const timeout : number = config.get("timeout") ?? 20000;
	const localsave : boolean = config.get("localStorage.enable") ?? false;
	const localpath : string = config.get("localStorage.folder") ?? "";
	const fileIgnore : Array<string> = config.get("ignoreTags") ?? [];

	console.log("Ignore labels:");
	console.log(fileIgnore);

	const wfmProvider = new WorkflowManagerProvider(server, username, secretStorage, port, localsave, localpath, timeout, fileIgnore);
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider('wfm', wfmProvider, { isCaseSensitive: true }));
	context.subscriptions.push(vscode.window.registerFileDecorationProvider(wfmProvider));
	wfmProvider.extContext=context;

	const header = new CodelensProvider(server);
	context.subscriptions.push(vscode.languages.registerCodeLensProvider({language: 'yaml', scheme: 'wfm'}, header));

	// PUBLISHING COMMANDS

	// --- Validate the definition in WFM
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.validate', async () => {
		wfmProvider.validate();
	}));

	// --- Open workflow in Workflow Manager (Webbrowser)
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.openInBrowser', async () => {
		wfmProvider.openInBrowser();
	}));

	// --- Apply schema for validation
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.applySchema', async () => {
		wfmProvider.applySchema();
	}));

	// --- Run workflow in WFM
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.execute', async () => {
		wfmProvider.execute();
	}));

	// --- Get last execution result
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.lastResult', async () => {
		wfmProvider.lastResult();
	}));

	// --- Upload workflow from local file-system
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.upload', async () => {
		wfmProvider.upload();
	}));

	// Generate schema for validation
	wfmProvider.generateSchema();

	// Apply YAML language to all wfm:/actions/* and wfm:/workflows/* files
	let fileAssociations : {string: string} = vscode.workspace.getConfiguration('files').get('associations') || <{string: string}>{};
    fileAssociations["/actions/*"] = "yaml";
    fileAssociations["/workflows/*"] = "yaml";
    vscode.workspace.getConfiguration('files').update('associations', fileAssociations);

	// --- WORKFLOW EXAMPLES -------------------------------------------------

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
			console.log('nsp-workflow already exists, add to workspace');
			vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, { uri: repoUri});
		} else {
			console.log('clone nsp-workflow to add to workspace');
			vscode.commands.executeCommand('git.clone', 'https://github.com/nokia/nsp-workflow.git', gitPath);
		}
	}));

	vscode.commands.registerCommand('nokia-wfm.setPassword', async () => {
		const passwordInput: string = await vscode.window.showInputBox({
		  password: true, 
		  title: "Password"
		}) ?? '';
		
		if(passwordInput !== ''){
			secretStorage.store("nsp_wfm_password", passwordInput);
		};
	  });

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

	// Add Workflow Manager to workspace
	vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, { uri: vscode.Uri.parse('wfm:/'), name: "Workflow Manager" });
}
/**
 * Copyright 2023 Nokia
 * Licensed under the BSD 3-Clause License.
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as vscode from 'vscode';

export class FileStat implements vscode.FileStat {
	id: string;
    type: vscode.FileType;
    ctime: number;
    mtime: number;
    size: number;
	signed: boolean;

	constructor (id: string, ctime: number, mtime: number, size:number, signed:boolean) {
		this.type = vscode.FileType.File;
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.size = 0;
		this.id = id;
		this.signed = signed;
	}
}

const DECORATION_SIGNED: vscode.FileDecoration =    new vscode.FileDecoration(
	'🔒',
	'Signed',
	new vscode.ThemeColor('list.deemphasizedForeground')
);
const DECORATION_UNSIGNED: vscode.FileDecoration =    new vscode.FileDecoration(
	'',
	'Unsigned',
	new vscode.ThemeColor('list.highlightForeground')
);

export class WorkflowManagerProvider implements vscode.FileSystemProvider, vscode.FileDecorationProvider {
	static scheme = 'wfm';

	nspAddr: string;
	username: string;
	password: string;
	authToken: any|undefined;
	localsave: boolean;
	localpath: string;
	port: string;

	extContext: vscode.ExtensionContext;

	actions: {[name: string]: FileStat};
	workflows: {[name: string]: FileStat};

	public onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined>;
    private _eventEmiter: vscode.EventEmitter<vscode.Uri | vscode.Uri[]>;

	constructor (nspAddr: string, username: string, password: string, port: string, localsave: boolean, localpath: string) {
		console.log("creating WorkflowManagerProvider("+nspAddr+")");
		this.nspAddr = nspAddr;
		this.username = username;
		this.password = password;
		this.authToken = undefined;
		this.port = port;

		// caching actions/workflows for better performance
		// updated whenever calling readDirectory()
		this.actions = {};
		this.workflows = {};

		// used for FileDecorator        
		this._eventEmiter = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._eventEmiter.event;
		this.localsave = localsave;
		this.localpath = localpath;
	}

	dispose() {
		console.log("disposing WorkflowManagerProvider()");
		this._revokeAuthToken();
	}

	// --- private methods: auth-token

	private async _getAuthToken(): Promise<void> {
        console.log("executing _getAuthToken()");

        if (this.authToken) {
            if (!(await this.authToken)) {
                this.authToken = undefined;
            }
        }

        if (!this.authToken) {
            this.authToken = new Promise((resolve, reject) => {
                console.log("No valid auth-token; getting a new one...");
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

                const fetch = require('node-fetch');
                const base64 = require('base-64');

                const timeout = new AbortController();
                setTimeout(() => timeout.abort(), 10000);

                const url = "https://"+this.nspAddr+"/rest-gateway/rest/api/v1/auth/token";
                fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-cache',
                        'Authorization': 'Basic ' + base64.encode(this.username+ ":" +this.password)
                    },
                    body: '{"grant_type": "client_credentials"}',
                    signal: timeout.signal
                }).then(response => {
                    console.log("POST", url, response.status);
                    if (!response.ok) {
                        reject("Authentication Error!");
                        throw new Error("Authentication Error!");
                    }
                    return response.json();
                }).then(json => {
                    console.log("new authToken:", json.access_token);
                    resolve(json.access_token);
                    // automatically revoke token after 10min
                    setTimeout(() => this._revokeAuthToken(), 600000);
                }).catch(error => {
                    console.error(error.message);
                    // reject("Connection Error!");
					vscode.window.showWarningMessage("NSP is not reachable");
                    resolve(undefined);
                });
            });
        }
    }

	private async _revokeAuthToken(): Promise<void> {
		if (this.authToken) {
			const token = await this.authToken;
			console.log("_revokeAuthToken("+token+")");
			this.authToken = undefined;

			const fetch = require('node-fetch');
			const base64 = require('base-64');
		
			const url = "https://"+this.nspAddr+"/rest-gateway/rest/api/v1/auth/revocation";
			fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Authorization': 'Basic ' + base64.encode(this.username+ ":" +this.password)
				},
				body: 'token='+token+'&token_type_hint=token'
			})
			.then(response => {
				console.log("POST", url, response.status);
			});
		}
	}

	private async _callNSP(url:string, options:any): Promise<void>{
		const fetch = require('node-fetch');
		const timeout = new AbortController();
        setTimeout(() => timeout.abort(), 20000);
		options['signal']=timeout.signal;
		let response: any = new Promise((resolve, reject) => {
		 	fetch(url, options)
			.then(response => resolve(response))
			.catch(error => { 
				console.log(error.message);
				vscode.window.showWarningMessage("NSP is not reachable");
				resolve(undefined)});
		});
		return response;
	}

	// --- private methods: WFM workflows

	private async _createWorkflow(data: string): Promise<void> {

		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }

		// validate workflow definition

		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/validate';
		let response: any = await this._callNSP(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/plain',
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			},
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("POST", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Workflow validation failed!');
		}
		let json = await response.json();

		if (json.response.data.valid === 'false') {
			vscode.window.showErrorMessage(json.response.data.error);
			throw vscode.FileSystemError.NoPermissions('Invalid Workflow Definition');
		}
		vscode.window.showInformationMessage('Success: Workflow validated');

		// upload new workflow

		url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/definition?provider=';
		response = await this._callNSP(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/plain',
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			},
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("POST", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Workflow creation failed! Reason: '+response.statusText);
		}
		vscode.window.showInformationMessage('Success: Workflow uploaded');

		// update workflow cache

		json = await response.json();
		const entry =  json.response.data[0];

		const name = entry.name;
		const id = entry.id;
		const ctime = Date.parse(entry.created_at);
		const mtime = Date.parse(entry.updated_at);
		this.workflows[name] = new FileStat(id, ctime, mtime, data.length, false);

		// change to PUBLISHED

		url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/'+id+'/status';
		response = await this._callNSP(url, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			},
			body: '{"status": "PUBLISHED"}'
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("PUT", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Change mode to PUBLISHED failed! Reason: '+response.statusText);
		}

		vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
		vscode.window.showInformationMessage('Success: Workflow published');
	}

	private async _updateWorkflow(name: string, data: string, rename: boolean): Promise<void> {
		const yaml = require('yaml');
		const id = this.workflows[name].id;

		let defname = Object.keys(yaml.parse(data)).filter((value) => value !== "version")[0];

		if ((defname !== name) && (!rename)) {
			if (Object.keys(this.workflows).indexOf(defname)=== -1) {
				vscode.window.showInformationMessage('Workflow Name changed, creating new workflow.');
				await this._createWorkflow(data);
				let txtdoc = vscode.workspace.openTextDocument( vscode.Uri.parse("wfm:/workflows/"+defname));
				vscode.window.showTextDocument(txtdoc);
			} else {
				vscode.window.showErrorMessage("Cloning to an existing Workflow name is not allowed!");
			}
		} else if (this.workflows[name].signed) {
			vscode.window.showErrorMessage("Unable to save SIGNED workflow. To create a copy, modify the name in the definition.");
		} else {
			// get auth-token
			await this._getAuthToken();
			const token = await this.authToken;
			if (!token) {
				throw vscode.FileSystemError.Unavailable('NSP is not reachable');
			}

			// validate workflow definition
			let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/validate';
			let response: any = await this._callNSP(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'text/plain',
					'Cache-Control': 'no-cache',
					'Authorization': 'Bearer ' + token
				},
				body: data
			});
			if (!response){
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			}

			console.log("POST", url, response.status);
			if (!response.ok) {
				throw vscode.FileSystemError.Unavailable('Workflow validation failed!');
			}
			let json = await response.json();

			if (json.response.data.valid === 'false') {
				vscode.window.showErrorMessage(json.response.data.error);
				throw vscode.FileSystemError.NoPermissions('Invalid Workflow Definition');
			}
			vscode.window.showInformationMessage('Success: Workflow validated');

			// change to DRAFT
			url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/'+id+'/status';
			response = await this._callNSP(url, {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': 'no-cache',
					'Authorization': 'Bearer ' + token
				},
				body: '{"status": "DRAFT"}'
			});
			if (!response){
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			}

			console.log("PUT", url, response.status);
			if (!response.ok) {
				throw vscode.FileSystemError.Unavailable('Change mode to DRAFT failed!');
			}
			vscode.window.showInformationMessage('Success: Enabled DRAFT mode');

			// upload workflow
			url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/'+id+'/definition';
			response = await this._callNSP(url, {
				method: 'PUT',
				headers: {
					'Content-Type': 'text/plain',
					'Cache-Control': 'no-cache',
					'Authorization': 'Bearer ' + token
				},
				body: data
			});
			if (!response){
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			}

			console.log("PUT", url, response.status);
			if (!response.ok) {
				throw vscode.FileSystemError.Unavailable('Workflow upload failed! Reason: '+response.statusText);
			}
			vscode.window.showInformationMessage('Success: Workflow uploaded');

			// update workflow cache
			json = await response.json();
			let entry = json.response.data[0];

			if (name !== defname) {
				vscode.window.showWarningMessage('Workflow renamed');
				delete this.workflows[name];
				const ctime = Date.parse(entry.created_at);
				const mtime = Date.parse(entry.updated_at);
				this.workflows[defname] = new FileStat(id, ctime, mtime, data.length, false);	
				this.readDirectory(vscode.Uri.parse("wfm:/workflows"));
			} else {
				this.workflows[name].ctime = Date.parse(entry.created_at);
				this.workflows[name].mtime = Date.parse(entry.updated_at);
				this.workflows[name].size  = data.length;	
			}

			// change to PUBLISHED
			url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/'+id+'/status';
			response = await this._callNSP(url, {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': 'no-cache',
					'Authorization': 'Bearer ' + token
				},
				body: '{"status": "PUBLISHED"}'
			});
			if (!response){
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			}

			console.log("PUT", url, response.status);
			if (!response.ok) {
				throw vscode.FileSystemError.Unavailable('Change mode to PUBLISHED failed!');
			}
			vscode.window.showInformationMessage('Success: Workflow published');
			await vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");

			if (this.localsave===true) {
				let fs = require("fs");
				console.log("Saving a backup locally in the temp folder "+this.localpath);
				let extURI = vscode.Uri.parse("file://"+this.localpath);
				let filepath = vscode.Uri.joinPath(extURI, defname+'.yaml').toString().replace("file://","");
				fs.writeFile(filepath, data, (err) => { 
					if(err) { 
						console.log(err); 
					}
					console.log("Successfully saved in local repo."); 
				});
			}
		}
	}

	private async _deleteWorkflow(name: string): Promise<void> {

		const id : string = this.workflows[name].id;

		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }

		// change to DRAFT

		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/'+id+'/status';
		let response: any = await this._callNSP(url, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			},
			body: '{"status": "DRAFT"}'
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("PUT", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Change mode to DRAFT failed! Reason: '+response.statusText);
		}
		vscode.window.showInformationMessage('Success: Enabled DRAFT mode');

		// delete workflow

		url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/'+id;
		response = await this._callNSP(url, {
			method: 'DELETE',
			headers: {
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			}
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("DELETE", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Workflow deletion failed! Reason: '+response.statusText);
		}
		vscode.window.showInformationMessage('Success: Workflow deleted');

		// update workflow cache
		delete this.workflows[name];
	}

	private async _validateWorkflow(data: string): Promise<void> {

		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }

		// validate workflow definition

		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/validate';
		let response: any = await this._callNSP(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/plain',
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			},
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("POST", url, response.status);
		if (!response.ok) {
			vscode.window.showErrorMessage('Workflow validation failed!');
		} else {
			let json = await response.json();
			if (json.response.data.valid === 'false') {
				vscode.window.showErrorMessage('Invalid Workflow Definition:', json.response.data.error);
			} else {
				vscode.window.showInformationMessage('Success: Workflow validated');
			}
		}
	}

	private async _writeWorkflow(name: string, data: string): Promise<void> {
		if (name in this.workflows) {
			await this._updateWorkflow(name, data, false);
		} else {
			if (data.length === 0) {
				data = "---\nversion: '2.0'\n\n"+name+":\n  type: direct\n\n  description: this is a new workflow\n  \n  tags:\n    - demo\n\n  input:\n    - number1: 1234\n    - number2: 123\n    - ipAddress: '127.0.0.1'\n    - someText: 'my default value'\n    - pass: false\n    - delay: 1\n    - passRatio: 30\n\n  output:\n    devices: <% $.nodeList %>\n    sysinfo: <% $.sysInfo %>\n    rttinfo: <% $.rttInfo %>\n    time: <% $.timeInfo %>\n    \n  output-on-error:\n    result: 'Error occured, check logs for details'\n\n  tasks:\n    task1:\n      action: std.echo\n      input:\n        output:\n          someMath: <% $.number1 - $.number2 %>\n      publish:\n        randomNbr: <% 100*random() %>\n      on-success:\n        - pingLocalHost\n\n    pingLocalHost:\n      action: nsp.ping\n      input:\n        host: 127.0.0.1\n        duration: 1\n      publish:\n        rttInfo: <% task().result.RTT %>\n      on-success:\n        - getPythonVersionAndModules\n        - getTimestamp\n        - getNodes\n      on-error:\n        - fail\n\n    getNodes:\n      action: nsp.https\n      input:\n        url: 'https://restconf-gateway/restconf/operations/nsp-inventory:find'\n        method: POST\n        body: \n          input:\n            xpath-filter: /nsp-equipment:network/network-element\n            offset: 0\n            limit: 100\n            fields: ne-id;ne-name;ip-address;version;location;type;product\n            sort-by:\n              - ne-name\n      publish:\n        nodeList: <% task().result.content['nsp-inventory:output'] %>\n      on-complete:\n        - continue\n\n    getPythonVersionAndModules:\n      action: nsp.python\n      input:\n        context: <% $ %>\n        script: |\n          import sys\n          import platform\n          import pkg_resources\n\n          rvalue = {}\n          rvalue['sys.version']=sys.version\n          rvalue['platform.python_version']=platform.python_version()\n          rvalue['packages'] = sorted(['%s==%s' % (i.key, i.version) for i in pkg_resources.working_set])\n\n          return rvalue\n      publish:\n        sysInfo: <% task().result %>\n      on-complete:\n        - continue\n\n    getTimestamp:\n      action: std.js\n      input:\n        script: |\n          function getTS() {\n            const date = new Date();\n            let now = date.getTime();\n            return now;\n          }\n          return getTS();\n      publish:\n        timeInfo: <% task().result %>\n      on-complete:\n        - continue\n        \n    continue:\n      join: all    \n      action: std.noop\n      on-success:\n        - randomFailure: <% not $.pass %>\n        - done: <% $.pass %>\n        \n    randomFailure:\n      action: nsp.assert\n      input:\n        input: <% $.randomNbr < $.passRatio %>\n        expected: true\n        shouldFail: true\n      publish:\n        result: 'I am happy'\n      publish-on-error:\n        result: 'I am unhappy'\n      on-error:\n        - handleFailure\n      on-success:\n        - done\n\n    handleFailure:\n      action: std.sleep\n      input:\n        seconds: <% $.delay %>\n      on-success:\n        - done\n\n    done:\n      action: std.noop\n";
			}
			await this._createWorkflow(data);
		}
	}
	
	private async _renameWorkflow(oldName: string, newName: string): Promise<void> {
		const yaml = require('yaml');

		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }

		// get workflow definitions

		let url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/workflow/"+oldName+"/definition";
		let response: any = await this._callNSP(url, {
			method: 'GET',
			headers: {
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			}
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("GET", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.FileNotFound();
		}

		// update workflow definition

		let text = await response.text();
		let content = yaml.parse(text);
		content[newName] = content[oldName];
		delete content[oldName];

		// update workflow
		await this._updateWorkflow(oldName, yaml.stringify(content), true);
	}

	// --- private methods: WFM actions

	private async _createAction(data: string): Promise<void> {

		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }

		// validate action definition
		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/action/validate';
		let response: any = await this._callNSP(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/plain',
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			},
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("POST", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.NoPermissions('Action validation failed!');
		}
		let json = await response.json();

		if (json.response.data.valid === 'false') {
			vscode.window.showErrorMessage(json.response.data.error);
			throw vscode.FileSystemError.NoPermissions('Invalid Action Definition');
		}
		vscode.window.showInformationMessage('Success: Action validated');

		// upload new action
		url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/action/definition?provider=';
		response = await this._callNSP(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/plain',
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			},
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("POST", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Action creation failed! Reason: '+response.statusText);
		}
		vscode.window.showInformationMessage('Success: Action uploaded');

		json = await response.json();
		const entry = json.response.data[0];

		const name = entry.name;
		const id = entry.id;
		const ctime = Date.parse(entry.created_at);
		const mtime = Date.parse(entry.updated_at);
		this.actions[name] = new FileStat(id, ctime, mtime, data.length, false);

		vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
	}

	private async _updateAction(name: string, data: string): Promise<void> {
		const id = this.actions[name].id;

		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }

		// validate action definition
		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/action/validate';
		let response: any = await this._callNSP(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/plain',
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			},
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("POST", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.NoPermissions('Action validation failed!');
		}
		let json = await response.json();

		if (json.response.data.valid === 'false') {
			vscode.window.showErrorMessage(json.response.data.error);
			throw vscode.FileSystemError.NoPermissions('Invalid Action Definition');
		}
		vscode.window.showInformationMessage('Success: Action validated');

		// upload action

		url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/action/'+id+'/definition';
		response = await this._callNSP(url, {
			method: 'PUT',
			headers: {
				'Content-Type': 'text/plain',
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			},
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("PUT", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Action upload failed! Reason: '+response.statusText);
		}
		vscode.window.showInformationMessage('Success: Action uploaded');

		// update action cache

		json = await response.json();
		const entry = json.response.data[0];

		if (name !== entry.name) {
			vscode.window.showWarningMessage('Action renamed');
			delete this.actions[name];
			name = entry.name;

			const ctime = Date.parse(entry.created_at);
			const mtime = Date.parse(entry.updated_at);
			this.actions[name] = new FileStat(id, ctime, mtime, data.length, false);			
		} else {
			this.actions[name].ctime = Date.parse(entry.created_at);
			this.actions[name].mtime = Date.parse(entry.updated_at);
			this.actions[name].size  = data.length;	
		}
	}

	private async _deleteAction(name: string): Promise<void> {

		const id : string = this.actions[name].id;

		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }

		// delete action

		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/action/'+id;
		let response: any = await this._callNSP(url, {
			method: 'DELETE',
			headers: {
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			}
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("DELETE", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Action deletion failed! Reason: '+response.statusText);
		}
		vscode.window.showInformationMessage('Success: Action deleted');

		// update action cache
		delete this.actions[name];
	}

	private async _validateAction(data: string): Promise<void> {

		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }

		// validate action definition

		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/action/validate';
		let response: any = await this._callNSP(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/plain',
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			},
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("POST", url, response.status);
		if (!response.ok) {
			vscode.window.showErrorMessage('Action validation failed!');
		} else {
			let json = await response.json();
			if (json.response.data.valid === 'false') {
				vscode.window.showErrorMessage('Invalid Action Definition:', json.response.data.error);
			} else {
				vscode.window.showInformationMessage('Success: Action validated');
			}
		}
	}

	private async _writeAction(name: string, data: string): Promise<void> {
		if (name in this.actions) {
			await this._updateAction(name, data);
		} else {
			if (data.length === 0) {
				data = "---\nversion: '2.0'\n\n"+name+":\n  description: |\n    action: "+name+"\n  base: nsp.https\n  base-input:\n    url: 'https://restconf-gateway/restconf/operations/nsp-inventory:find'\n    method: POST\n    auth: <% $.token_auth %>      \n    body: \n      input:\n        xpath-filter: /nsp-equipment:network/network-element<% xpath_filter($.formValues.get('filter')) %>\n        offset: <% $.formValues.get('offset') %>\n        limit: <% $.formValues.get('limit') %>\n        fields: ne-id;ne-name;ip-address;version;location;type;product\n        sort-by:\n          - ne-id\n  input:\n    - token_auth\n    - formValues: {}\n  output: <% $.content['nsp-inventory:output'] %>\n";
			}
			await this._createAction(data);
		}
	}

	private async _renameAction(oldName: string, newName: string): Promise<void> {
		const yaml = require('yaml');

		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }

		// get action definitions

		let url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/action/"+oldName+"/definition";
		let response: any = await this._callNSP(url, {
			method: 'GET',
			headers: {
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			}
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("GET", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.FileNotFound();
		}

		// update action definition

		let text = await response.text();
		let content = yaml.parse(text);
		content[newName] = content[oldName];
		delete content[oldName];

		// update workflow

		await this._updateAction(oldName, yaml.stringify(content));
	}

	// --- private methods: WFM executions

	private async _getWebviewContent(wfnm: string,exectime: string,execstat: string,execid: string,state_info: string,panel: vscode.WebviewPanel): Promise<string> {
		let path = require('path');

		const extURI = this.extContext.extensionUri;
		const onDiskPath = vscode.Uri.joinPath(extURI, 'media', 'noklogo_black.svg');
		const catGifSrc = panel.webview.asWebviewUri(onDiskPath);
		const codiconsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extURI, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'));

		let html=`<!doctype html><html><head><title>WFM Report</title><meta name="description" content="WFM Execution report"><meta name="keywords" content="WFM execution report"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@100;300&display=swap" rel="stylesheet"><link href="`+codiconsUri+`" rel="stylesheet" /><style>*{ box-sizing: border-box; -webkit-box-sizing: border-box; -moz-box-sizing: border-box;}body{ font-family: 'Poppins', sans-serif; -webkit-font-smoothing: antialiased; background-color: #F8F8F8;}h2{ font-family: 'Poppins', sans-serif; text-align: left; font-size: 14px; letter-spacing: 1px; color: #555; margin: 20px 3%; width: 94%;}h3{ font-family: 'Poppins', sans-serif; text-align: left; font-size: 14px; letter-spacing: 1px; color: #555; margin: 20px 3%; width: 94%;}.publish { height: 100px; width: 100%; overflow-y: auto; }.nokia { display: block; margin-left: auto; margin-right: auto; margin-top: 100px; width: 30%;}.icon { width: 10px; margin-right: 0px;}.accordion > input[type="checkbox"] { position: absolute; left: -100vw;}.accordion .content { overflow-y: hidden; height: 0; transition: height 0.3s ease;}.accordion > input[type="checkbox"]:checked ~ .content { height: auto; overflow: visible;}.accordion label { display: block;}/* Styling*/body { font: 16px/1.5em "Overpass", "Open Sans", Helvetica, sans-serif; color: #333; font-weight: 300;}.accordion { margin-bottom: 1em; margin-left: 3%; width: 94%;}.accordion > input[type="checkbox"]:checked ~ .content { background: #F0F0F0 ; padding: 15px; border-bottom: 1px solid #9E9E9E;}.accordion .handle { margin: 0; font-size: 15px; line-height: 1.2em; width: 100%;}.accordion label { color: #555; cursor: pointer; font-weight: normal; padding: 15px; background: #F8F8F8; border-bottom: 1px solid #9E9E9E;}.accordion label:hover,.accordion label:focus { background: #BEBEBE; color: #001135;font-weight: 500;}/* Demo purposes only*/*,*:before,*:after { box-sizing: border-box;}body { padding: 40px;}a { color: #06c;}p { margin: 0 0 1em; font-size: 13px;}h1 { margin: 0 0 1.5em; font-weight: 600; font-size: 1.5em;}.accordion { max-width: 65em;}.accordion p:last-child { margin-bottom: 0;}</style></head><body><td><img class="nokia" src="`+catGifSrc+`"></td>`;
		html=html+`<h2>Workflow `+wfnm+`</h2><h2>Execution `+execid+`</h2><h3>Status: `+execstat+` at `+exectime+`</h3>`;
		if (execstat==="ERROR") html=html+`<h3>`+state_info+`</h3>`;
		

		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }
		
		let url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/task/execution/"+execid;
		console.log(url);
		let resp: any = await this._callNSP(url, {
			method: 'GET',
			headers: {
				'Authorization': 'Bearer ' + token,
				'Accept': '*/*',
				'Content-Type': 'application/json'
			}
		});
		if (!resp){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}
		let data = await resp.json();
		console.log(data);
		let i=0;
		data.response.data.forEach(function(task){
			let taskid = task.id;
			let taskname = task.name;
			let taskstat = task.state;
			let publish = task.published;
			let vscodeicon = `<i class="codicon codicon-error" style="margin-right:20px; font-size:20px; color:red;"></i>`;
			if (taskstat === "SUCCESS") vscodeicon = `<i class="codicon codicon-pass icon" style="margin-right:20px; font-size:20px; color:green;"></i>`;
			else if (taskstat === "RUNNING") vscodeicon = `<i class="codicon codicon-refresh" style="margin-right:20px; font-size:20px; color:blue;"></i>`;
			html=html+`<section class="accordion"><input type="checkbox" name="collapse`+i+`" id="handle`+i+`"> <h2 class="handle"> <label for="handle`+i+`"><img class="icon">`+vscodeicon+taskname+`</label> </h2> <div class="content"> <p><strong>Task name:  </strong>`+taskname+`</p> <p><strong>ID:  </strong>`+taskid+`</p> <p><strong>Status:  </strong>`+taskstat+`</p><p class="publish">`+JSON.stringify(publish, undefined, 4)+`</p>`;
			if (taskstat === "RUNNING") html=html+`<a href="https://135.228.140.182:8546/workflow-manager/workflows/`+wfnm+`/executions/`+execid+`/tasks/`+taskid+`/actionExecutions">See in WFM</a>`;
			html=html+`</div></section>`;

			i=i+1;
			console.log(JSON.stringify(publish, undefined, 4));
		});
		
		html=html+`</body></html>`;
		return html;
	}

	// --- public methods

	async validate(): Promise<void> {
		const YAML = require('yaml')
		const editor = vscode.window.activeTextEditor;

		if (editor) {
			const uri = vscode.window.activeTextEditor?.document.uri.toString();
			console.error(uri);

			if (uri?.startsWith('wfm:/workflows/')) {
				this._validateWorkflow(editor.document.getText());
			} else if (uri?.startsWith('wfm:/actions/')) {
				this._validateAction(editor.document.getText());
			} else {
				let doc = YAML.parse(editor.document.getText());
				let key = Object.keys(doc).filter((value) => value !== "version")[0];
				if ('base-input' in doc[key]) {
					this._validateAction(editor.document.getText());					
				} else {
					this._validateWorkflow(editor.document.getText());
				}
			}
		}
	}

	async openInBrowser(): Promise<void> {
		const YAML = require('yaml')
		const editor = vscode.window.activeTextEditor;

		if (editor) {
			const uri = vscode.window.activeTextEditor?.document.uri.toString();

			if (uri?.startsWith('wfm:/workflows/')) {
				const key = uri.toString().substring(15);
				const url = "https://"+this.nspAddr+":"+this.port+"/workflow-manager/workflows/"+key;
				vscode.env.openExternal(vscode.Uri.parse(url));
			} else if (uri?.startsWith('wfm:/actions/')) {
				const key = uri.toString().substring(13);
				const url = "https://"+this.nspAddr+":"+this.port+"/workflow-manager/actions/"+key;
				vscode.env.openExternal(vscode.Uri.parse(url));
			} else {
				let doc = YAML.parse(editor.document.getText());
				let key = Object.keys(doc).filter((value) => value !== "version")[0];
				if ('base-input' in doc[key]) {
					if (Object.keys(this.actions).length === 0) {
						await this.readDirectory(vscode.Uri.parse('wfm:/actions'));
					}
					if (key in this.actions) {
						const url = "https://"+this.nspAddr+":"+this.port+"/workflow-manager/actions/"+key;
						vscode.env.openExternal(vscode.Uri.parse(url));
					} else {
						vscode.window.showErrorMessage('Need to upload action '+key+' to WFM first!');
					}
					
				} else {
					if (Object.keys(this.workflows).length === 0) {
						await this.readDirectory(vscode.Uri.parse('wfm:/workflows'));
					}		
					if (key in this.workflows) {
						const url = "https://"+this.nspAddr+":"+this.port+"/workflow-manager/workflows/"+key;
						vscode.env.openExternal(vscode.Uri.parse(url));
					} else {
						vscode.window.showErrorMessage('Need to upload workflow '+key+' to WFM first!');
					}
				}
			}
		}
	}

	async applySchema(): Promise<void>{
		const editor = vscode.window.activeTextEditor;
		const extURI = this.extContext.extensionUri;
		let outpath = vscode.Uri.joinPath(extURI, 'schema', 'wfm-schema.json').toString().replace("file://","");
		if (editor) {
			const document = editor.document;
			const wfmSchema = outpath;
			const workflowUri = document.uri.toString();
			let schemas = vscode.workspace.getConfiguration('yaml').get('schemas');
			if (schemas[wfmSchema]) {
				if (Array.isArray(schemas[wfmSchema])) {
					if (schemas[wfmSchema].indexOf(workflowUri) === -1)
						(schemas[wfmSchema] as Array<string>).push(workflowUri);
				} else if (typeof schemas[wfmSchema] === 'string') {
					if (schemas[wfmSchema] !== workflowUri)
						schemas[wfmSchema] = [schemas[wfmSchema], workflowUri];
				}
			} else {
				schemas[wfmSchema] = workflowUri;
			}
			vscode.workspace.getConfiguration('yaml').update('schemas', schemas);
		}
	}

	async execute(): Promise<void>{
		const YAML = require('yaml')
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			let ym = YAML.parse(editor.document.getText());
			let wfnm = Object.keys(ym).filter((value) => value !== "version")[0];
			
			let id=this.workflows[wfnm].id;
			let inputatt: {[name: string]: string}={};

			let allwfs:JSON = {} as JSON;

			var stringConstructor = "test".constructor;
			var objectConstructor = ({}).constructor;

			vscode.window.showInformationMessage('Executing workflow '+wfnm+' in WFM.');
			
			let attrib: string|undefined="{}";
			if (ym[wfnm].hasOwnProperty('input') === true) {
				ym[wfnm].input.forEach(function(key){
					if (key.constructor === stringConstructor) {
						inputatt[key]="";
					}
					if (key.constructor === objectConstructor) {
						let aux=Object.keys(key)[0];
						inputatt[aux]=key[aux];
					}
				})
			//	ym[wfnm].input.forEach(function(key){
					attrib = await vscode.window.showInputBox({
						placeHolder: JSON.stringify(inputatt),
						prompt: "Fill the attribute value",
						value: JSON.stringify(inputatt)
					});
			//	});
			}

			let attribjs = await JSON.parse(attrib);

			let data;
		
			const fetch = require('node-fetch');

			// get auth-token
			await this._getAuthToken();
			const token = await this.authToken;
			if (!token) {
				throw vscode.FileSystemError.Unavailable('NSP is not reachable');
			}

			const requestHeaders = new fetch.Headers({
				"Content-Type": "application/json",
				"Cache-Control": "no-cache",
				'Authorization': 'Bearer ' + token
			});

			let url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/execution";
			const wfm_response: any = await this._callNSP(url,{method: 'POST',
				headers: requestHeaders,
				body: JSON.stringify(
					{
						workflow_id: id,
						workflow_name: wfnm,
						description: "workflow execution from vsCode",
						input: attribjs
						}
				)
			});
			if (!wfm_response){
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			}

				data = await wfm_response.json();
				console.log(data);

			let execid = data.response.data[0].id;
			
			vscode.window.showInformationMessage('Workflow '+wfnm+' execution sent',"See in WFM","Cancel").then((selectedItem) => {
				if ('See in WFM' === selectedItem) {
					vscode.env.openExternal(vscode.Uri.parse("https://"+this.nspAddr+":"+this.port+"/workflow-manager/workflows/"+wfnm+"/executions/"+execid));
				}
				});
		}
	}

	async lastResult(): Promise<void>{
		const YAML = require('yaml');
		const fetch = require('node-fetch');

		const editor = vscode.window.activeTextEditor;
		if (editor) {
			vscode.window.showInformationMessage('Retrieving Last Execution Result.');

			// get auth-token
			await this._getAuthToken();
			const token = await this.authToken;
			if (!token) {
				throw vscode.FileSystemError.Unavailable('NSP is not reachable');
			}

			let ym = YAML.parse(editor.document.getText());
			let wfnm = Object.keys(ym).filter((value) => value !== "version")[0];

			let data;
					
			const requestHeaders = new fetch.Headers({
				"Content-Type": "application/json",
				"Cache-Control": "no-cache",
				'Authorization': 'Bearer ' + token
			});

			const wfm_response: any = await this._callNSP("https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/execution/workflow/"+wfnm+"?fields=id,updated_at,state",{method: 'GET',
				headers: requestHeaders,
			});
			
			if (!wfm_response){
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			}

			data = await wfm_response.json();

			console.log("WFM Response:",data);
			let aux = data.response.data.pop()
			let exectime = aux.updated_at;
			let execstat = aux.state;
			let execid = aux.id;
			let state_info = aux.state_info;
			var path = require('path');
			vscode.window.showInformationMessage('Last execution info:'+exectime+"\nwith status: "+execstat,"See in WFM","Details","Cancel").then( async (selectedItem) => {
				if ('Details' === selectedItem) {
					//Beta
					console.log(path.join(this.extContext.extensionPath, 'media'));
					const panel = vscode.window.createWebviewPanel(
						'executionReport',
						wfnm+' Execution',
						vscode.ViewColumn.Two,
						{localResourceRoots: 
							[vscode.Uri.file(path.join(this.extContext.extensionPath, 'media')), vscode.Uri.file(path.join(this.extContext.extensionPath, 'node_modules'))]}
					);
					panel.webview.html = await this._getWebviewContent(wfnm,exectime,execstat,execid,state_info,panel);
				} else if ('See in WFM' === selectedItem){
					vscode.env.openExternal(vscode.Uri.parse("https://"+this.nspAddr+":"+this.port+"/workflow-manager/workflows/"+wfnm+"/executions/"+aux.id));
				}
			});
			
		}
	}

	async upload(): Promise<void> {
		const YAML = require('yaml')
		const editor = vscode.window.activeTextEditor;

		if (editor) {
			// Note: uses the action/workflow name from local YAML definition
			const doc = editor.document.getText();
			const obj = YAML.parse(doc);
			let key = Object.keys(obj).filter((value) => value !== "version")[0];
			if ('base-input' in obj[key]) {
				this._writeAction(key, doc);
			} else {
				this._writeWorkflow(key, doc);
			}
		}
	}

	async generateSchema(): Promise<void> {
		let data;
		
		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }
	
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
		let config = vscode.workspace.getConfiguration('workflowManager');
		const extURI = this.extContext.extensionUri;
		let templatePath = vscode.Uri.joinPath(extURI, 'schema', 'wfm-schema-builder.json.j2').toString().replace("file://","");
		let outpath = vscode.Uri.joinPath(extURI, 'schema', 'wfm-schema.json').toString().replace("file://","");
		let snippetsfile = vscode.Uri.joinPath(extURI, 'schema', 'snippets.json').toString().replace("file://","");
		let snippets:JSON={} as JSON;
		let url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/action";
		const wfm_response: any = await this._callNSP(url,{method: 'GET',
			headers: {
				"Content-Type": "text/plain",
				"Cache-Control": "no-cache",
				'Authorization': 'Bearer ' + token
			},
		});

		if (!wfm_response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		data = await wfm_response.json();
		//console.log(data);
		
		let actions = data.response.data;
		let entries:JSON = {} as JSON;
		entries["actions"] = [];
		const YAML = require('yaml');
		const ny = require('nunjucks');
		let actionlist = [];
		actions.forEach(function(action) {
		let entry:JSON = {} as JSON;

		try {
			let ym = YAML.parse(action.description);
			//console.log(ym);
			entry["name"]=ym.action;
			//console.log("a: ",entry.name);
			if (Object.keys(ym).includes("examples")){
				console.log("found examples");
				const ex1 = Object.keys(ym.examples)[0];
				console.log(ex1);
				snippets[ym.action]={"scope":"yaml","prefix":ym.action,"description":ex1,"body":[ym.examples[ex1]]};
				console.log({"scope":"yaml","prefix":ym.action,"description":ex1,"body":[ym.examples[ex1]]});
			}
			entry["description"] = ym.short_description.replace("\n", " ").trim();
				entry["properties"] = ym.input;
			Object.keys(entry.properties).forEach(function (arg){
				if (Object.keys(entry.properties[arg]).indexOf("description") !== -1){
					var auxi = entry.properties[arg]["description"].split("\n")[0];
					entry.properties[arg]["description"] = auxi;
				}
			});
		} catch {
			entry["name"]=action.name;
			//console.log("b: ",entry.name);
			if(Object.keys(action).indexOf("description") === -1 || !(action["description"])){
				entry["description"] = "";
			} else if (Object.keys(action.description).indexOf("\n") === -1){
				var auxi = action.description.split("short_description: ")[1];
				//console.log(auxi.split("\n")[0]);
				if (auxi){
					entry["description"] = auxi.split("\n")[0];
				} else {
					entry["description"] = "No description provided";
				}
				//action.description.replace("\n", "").replace("\"", "`").replace("'", "`").trim();
			}
			let props:JSON = {} as JSON;
			action["input"].split(', ').forEach( function(property_name){
				if (property_name.indexOf("=") !== -1){
					property_name = property_name.split('=')[0];
					let default_value = property_name.split('=')[1];
				}
				
				
				if (/^[a-zA-Z].*$/.test(property_name)===true){
					props[property_name] = {};
				}
			});
			entry["properties"] = props;
		}
		if (actionlist.indexOf(entry.name)===-1) {
			entries.actions.push(entry);
			actionlist.push(entry.name);
		}
		});

		console.log(snippets);

		//console.log(entries);
		var res = ny.render(templatePath, entries);
		//console.log(res);
		let fs = require("fs");
		fs.writeFile(outpath, res, (err) => { 
		if(err) { 
			console.log(err); 
		}
		console.log("Data has been written to file successfully."); 
		});

		fs.writeFile(snippetsfile, JSON.stringify(snippets,null,'\t'), (err) => { 
			if(err) { 
				console.log(err); 
			}
			console.log("Data has been written to file successfully."); 
		});
		

		const wfmSchema = outpath;
		const workflowUri = "wfm:/workflows/*";
		let schemas = vscode.workspace.getConfiguration('yaml').get('schemas');
		if (schemas[wfmSchema]) {
			if (Array.isArray(schemas[wfmSchema])) {
				if (schemas[wfmSchema].indexOf(workflowUri) === -1) {
					(schemas[wfmSchema] as Array<string>).push(workflowUri);
				}
			} else if (typeof schemas[wfmSchema] === 'string') {
				if (schemas[wfmSchema] !== workflowUri) {
					schemas[wfmSchema] = [schemas[wfmSchema], workflowUri];
				}
			}
		} else {
			schemas[wfmSchema] = workflowUri;
		}
		vscode.workspace.getConfiguration('yaml').update('schemas', schemas);

	}

	// --- implement FileSystemProvider
	
	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		console.log("executing readDirectory("+uri+")");

		let url = undefined;
		if (uri.toString() === "wfm:/") {
			return [['actions', vscode.FileType.Directory],['workflows', vscode.FileType.Directory]];
		} else if (uri.toString() === "wfm:/workflows") {
			url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/workflow?fields=id,name,created_at,updated_at";
		} else if (uri.toString() === "wfm:/actions") {
			url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/action?fields=id,name,created_at,updated_at&is_system=false"; 
		} else {
			throw vscode.FileSystemError.FileNotADirectory('Unknown resouce!');
		}

		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }
	
		// get list of all workflow / action definitions

		let response: any = await this._callNSP(url, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			}
		});

		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("GET", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Cannot get workflow list');
		}
		const json = await response.json();

		if (uri.toString() === "wfm:/workflows") {
			this.workflows = (json?.response.data ?? []).reduce((workflows:{}, entry:{}) =>
				(workflows[entry.name] = new FileStat(entry.id, Date.parse(entry.created_at), Date.parse(entry.updated_at), 0, entry.details.signature === "SIGNED"), workflows), {}
			);
		} else {
			this.actions = (json?.response.data ?? []).reduce((actions:{}, entry:{}) =>
				(actions[entry.name] = new FileStat(entry.id, Date.parse(entry.created_at), Date.parse(entry.updated_at), 0, entry.actionDetail.signature === "SIGNED"), actions), {}
			);
		}

		let result: [string, vscode.FileType][] = (json?.response.data ?? []).map<[string, vscode.FileType]> (entry => [entry.name, vscode.FileType.File]);
		return result;
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		console.log("executing stat("+uri+")");

		if ((uri.toString()==='wfm:/') || (uri.toString()==='wfm:/workflows') || (uri.toString()==='wfm:/actions')) {
			return {
				type: vscode.FileType.Directory,
				ctime: 0,
				mtime: Date.now(),
				size: 0,
				permissions: vscode.FilePermission.Readonly
			};
		} else if (uri.toString().startsWith('wfm:/workflows/')) {
			if (Object.keys(this.workflows).length === 0) {
				await this.readDirectory(vscode.Uri.parse('wfm:/workflows'));
			}
			const key = uri.toString().substring(15);
			if (key in this.workflows) {
				return this.workflows[key];
			}
			throw vscode.FileSystemError.FileNotFound('Unknown workflow!');
		} else if (uri.toString().startsWith('wfm:/actions/')) {
			if (Object.keys(this.actions).length === 0) {
				await this.readDirectory(vscode.Uri.parse('wfm:/actions'));
			}
			const key = uri.toString().substring(13);
			if (key in this.actions) {
				return this.actions[key];
			}
			throw vscode.FileSystemError.FileNotFound('Unknown action!');
		};
		throw vscode.FileSystemError.FileNotFound('Unknown resouce!');
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		console.log("executing readFile("+uri+")");

		let url = undefined;
		if (uri.toString().startsWith("wfm:/workflows/")) {
			let id = uri.toString().substring(15);
			url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/workflow/"+id+"/definition";
		} else if (uri.toString().startsWith("wfm:/actions/")) {
			let id = uri.toString().substring(13);
			url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/action/"+id+"/definition";
		} else {
			throw vscode.FileSystemError.FileNotADirectory('Unknown resouces!');
		}
	
		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }

		// get workflow / action definition

		let response: any = await this._callNSP(url, {
			method: 'GET',
			headers: {
				'Cache-Control': 'no-cache',
				'Authorization': 'Bearer ' + token
			}
		});

		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		console.log("GET", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}

		let text = await response.text();
		return Buffer.from(text);
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Promise<void> {
		console.log("executing writeFile("+uri+")");
		if (uri.toString().startsWith('wfm:/workflows/')) {
			const key = uri.toString().substring(15);
			await this._writeWorkflow(key, content.toString());
		} else if (uri.toString().startsWith('wfm:/actions/')) {
			const key = uri.toString().substring(13);
			await this._writeAction(key, content.toString());
		} else {
			throw vscode.FileSystemError.FileNotFound('Unknown resource-type!');
		}
	}

	async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		console.log("executing rename("+oldUri+", "+newUri+")");

		if (oldUri.toString().startsWith('wfm:/workflows/') && newUri.toString().startsWith('wfm:/workflows/')) {
			const oldName : string = oldUri.toString().substring(15);
			const newName : string = newUri.toString().substring(15);
			await this._renameWorkflow(oldName, newName);
		} else if (oldUri.toString().startsWith('wfm:/actions/') && newUri.toString().startsWith('wfm:/actions/')) {
			const oldName : string = oldUri.toString().substring(13);
			const newName : string = newUri.toString().substring(13);
			await this._renameAction(oldName, newName);
		} else {
			throw vscode.FileSystemError.NoPermissions('Unsupported operation!');
		}
	}

	async delete(uri: vscode.Uri): Promise<void> {
		console.log("executing delete("+uri+")");

		if (uri.toString() === "wfm:/workflows") {
			throw vscode.FileSystemError.NoPermissions('Permission denied!');
		} else if (uri.toString() === "wfm:/actions") {
			throw vscode.FileSystemError.NoPermissions('Permission denied!');
		} else if (uri.toString().startsWith("wfm:/workflows/")) {
			let key = uri.toString().substring(15);
			await this._deleteWorkflow(key);
		} else if (uri.toString().startsWith("wfm:/actions/")) {
			let key = uri.toString().substring(13);
			await this._deleteAction(key);
		} else {
			throw vscode.FileSystemError.FileNotFound('Unknown resouces!');
		}
	}

	createDirectory(uri: vscode.Uri): void {
		console.log("executing createDirectory("+uri+")");
		throw vscode.FileSystemError.NoPermissions('Unknown resouce!');
	}

	// --- implement FileDecorationProvider

	public provideFileDecoration( uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
		if (uri.toString().startsWith('wfm:/workflows/')) {
			const key = uri.toString().substring(15);
			if (this.workflows[key].signed) return DECORATION_SIGNED;
			return DECORATION_UNSIGNED;
		} else if (uri.toString().startsWith('wfm:/actions/')) {
			const key = uri.toString().substring(13);
			if (this.actions[key].signed) return DECORATION_SIGNED;
			return DECORATION_UNSIGNED;
		}
	}	
	// --- manage file events

	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

	watch(_resource: vscode.Uri): vscode.Disposable {
		// ignore, fires for all changes...
		return new vscode.Disposable(() => { });
	}	
}
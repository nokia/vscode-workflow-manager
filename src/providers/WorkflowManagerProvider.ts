/**
 * Copyright 2023 Nokia
 * Licensed under the BSD 3-Clause License.
 * SPDX-License-Identifier: BSD-3-Clause
*/

import * as vscode from 'vscode';
import fetch = require('node-fetch');
import base64 = require('base-64');

const COLOR_OK            = new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'); // appears green
const COLOR_READONLY      = new vscode.ThemeColor('list.deemphasizedForeground');
const COLOR_ERROR         = new vscode.ThemeColor('list.errorForeground');
const DECORATION_DISCONNECTED = { badge: '❗', tooltip: 'Not connected!', color: COLOR_ERROR };  // should become codicon $(warning)
const DECORATION_CONNECTED    = { badge: '✔',  tooltip: 'Connecting...', color: COLOR_OK };     // should become codicon $(vm-active)

const DECORATION_SIGNED       = { badge: '🔒', tooltip: 'Workflow: Signed', color: COLOR_READONLY};
const DECORATION_UNSIGNED: vscode.FileDecoration =    new vscode.FileDecoration(
	'', 'Workflow: Unsigned', new vscode.ThemeColor('list.highlightForeground')
);

export class FileStat implements vscode.FileStat { // FileStat is a class that contains the file status

	id: string;
    type: vscode.FileType;
    ctime: number;
    mtime: number;
    size: number;
	signed: boolean;

	constructor (id: string, fileType: string, ctime: number, mtime: number, size:number, signed:boolean) {
		if (fileType === 'file') {
			this.type = vscode.FileType.File;
		}
		if (fileType === 'directory') {
			this.type = vscode.FileType.Directory;
		}
		this.ctime = ctime;
		this.mtime = mtime;
		this.size = 0;
		this.id = id;
		this.signed = signed;
	}
}

/*
	Class implementing FileSystemProvider for Workflow Manager
*/
export class WorkflowManagerProvider implements vscode.FileSystemProvider, vscode.FileDecorationProvider {
	static scheme = 'wfm';
	// workflow manager attributes
	nspAddr: string;
	username: string;
	password: string;
	authToken: any|undefined;
	localsave: boolean;
	localpath: string;
	port: string;
	timeout: number;
	fileIgnore: Array<string>;
	secretStorage: vscode.SecretStorage;
	extContext: vscode.ExtensionContext;
	nspVersion: number[] | undefined; // NSP version
	osdVersion: number[] | undefined; // NSP OSD version
	actions: {[name: string]: FileStat}; // DS for actions
	templates: {[name: string]: FileStat}; // DS for templates
	workflows: {[name: string]: FileStat}; // DS for workflows
	workflow_documentations: {[name: string]: FileStat}; // DS for workflow_documentations
	workflow_views: {[name: string]: FileStat}; // DS for workflow_views
	workflow_folders: {[name: string]: FileStat}; // DS for workflow_folders
	pluginLogs: vscode.LogOutputChannel;
	
	public onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined>;
    private _eventEmiter: vscode.EventEmitter<vscode.Uri | vscode.Uri[]>;

	/**
	 * Create WorkflowManagerProvider
	 * @param {string} nspAddr IP address or hostname of NSP (from extension settings)
	 * @param {string} username NSP user
	 * @param {vscode.SecretStorage} secretStorage used to retrieve NSP password
	 * @param {string} port NSP port number
	 * @param {boolean} localsave save workflows locally
	 * @param {string} localpath path to save workflows locally
	 * @param {number} timeout in seconds
	 * @param {fileIgnore} fileIgnore hide intent-types with provided labels to keep filesystem clean
	*/	

	constructor (nspAddr: string, username: string, secretStorage: vscode.SecretStorage, port: string, localsave: boolean, localpath: string, timeout: number, fileIgnore: Array<string>) {
		this.nspAddr = nspAddr;
		this.username = username;
		this.authToken = undefined;
		this.port = port;
		this.timeout = timeout;
		this.fileIgnore = fileIgnore;
		this.secretStorage = secretStorage;
		this.nspVersion = undefined;
		this.osdVersion = undefined;
		
		// caching actions/workflows/templates for better performance - updated whenever calling readDirectory()
		this.actions = {};
		this.workflows = {};
		this.templates = {};
		this.workflow_documentations = {};
		this.workflow_views = {};
		this.workflow_folders = {};

		// Instantiate the pluginLogs output channel
		this.pluginLogs = vscode.window.createOutputChannel('WFM Plugin Logs', {log: true});

		// used for FileDecorator        
		this._eventEmiter = new vscode.EventEmitter(); // Event emitter for file decorations
        this.onDidChangeFileDecorations = this._eventEmiter.event;

		this.localsave = localsave;
		this.localpath = localpath;
	}

	dispose() {
		this.pluginLogs.info("[WFM]: disposing WorkflowManagerProvider()");
		this._revokeAuthToken();
		this.pluginLogs.dispose();
	}

	// --- private methods -----------------------------------
	/**
	* Retrieves auth-token from NSP. Implementation uses promises to ensure that only
	* one token is used at any given moment of time. The token will automatically be
	* revoked after 10min.
	*/	
	private async _getAuthToken(): Promise<void> {
		this.pluginLogs.info("[WFM]: _getAuthToken()");
	
		if (this.authToken) { // Check if we already have a valid authToken
			const token = await this.authToken;
			if (token) {
				this.pluginLogs.info("[WFM]: Using existing authToken");
				return;
			} else {
				this.pluginLogs.warn("Existing authToken is invalid, resetting");
				this.authToken = undefined; // Reset authToken if it is undefined
			}
		}
	
		// Retrieve the password from secret storage
		this.password = await this.secretStorage.get("nsp_wfm_password");
	
		// Only proceed if we have a password and no valid authToken
		if (this.password && !this.authToken) {
			this.authToken = new Promise((resolve, reject) => {
				this.pluginLogs.warn("No valid auth-token; Getting a new one...");
				process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	
				const timeout = new AbortController();
				const timeoutId = setTimeout(() => {
					this.pluginLogs.warn("Aborting fetch request due to timeout");
					timeout.abort();
				}, 10000);
	
				const url = "https://"+this.nspAddr+"/rest-gateway/rest/api/v1/auth/token";
				const startTS = Date.now();
	
				fetch(url, {
					method: "POST",
					headers: {
						'Content-Type': 'application/json',
						'Cache-Control': 'no-cache',
						'Authorization': 'Basic ' + base64.encode(this.username + ":" + this.password)
					},
					body: '{"grant_type": "client_credentials"}',
					signal: timeout.signal
				}).then(async (response: any) => {
					clearTimeout(timeoutId); // Clear the timeout if fetch is successful
					const duration = Date.now() - startTS;
					this.pluginLogs.info("[WFM]: POST", url, "finished within", duration, "ms");
	
					const json = await response.json();
					if (response.ok) {
						this.pluginLogs.info("[WFM]: Successfully obtained authToken");
						resolve(json.access_token);
						setTimeout(() => this._revokeAuthToken(), 600000); // automatically revoke token after 10min
					} else {
						this.pluginLogs.warn("NSP response:", response.status, json.error);
						DECORATION_DISCONNECTED.tooltip = "Authentication failure (user:" + this.username + ", error:" + json.error + ")!";
						this.authToken = undefined; // Reset authToken on error
						this.nspVersion = undefined;
						this._eventEmiter.fire(vscode.Uri.parse('wfm:/'));
						reject("Authentication Error!");
					}
				}).catch((error: any) => {
					clearTimeout(timeoutId); // Clear the timeout if fetch throws an error
					if (error.name === 'AbortError') {
						this.pluginLogs.error("Fetch request aborted due to timeout");
					} else {
						this.pluginLogs.error("Getting authToken failed with", error.message);
					}
	
					DECORATION_DISCONNECTED.tooltip = this.nspAddr + " unreachable!";
					this.nspVersion = undefined;
					this._eventEmiter.fire(vscode.Uri.parse('wfm:/'));
					this.authToken = undefined; // Reset authToken on error
					resolve(undefined);
				});
			});
		}
	}
	

	/**
	 * Gracefully revoke NSP auth-token.
	*/	
	private async _revokeAuthToken(): Promise<void> {
		this.pluginLogs.info("[WFM]: _revokeAuthToken()");
		if (this.authToken) {
			const fetch = require('node-fetch');
			const base64 = require('base-64');
			const token = await this.authToken;
			this.pluginLogs.debug("_revokeAuthToken("+token+")");
			this.authToken = undefined;

			const url = "https://"+this.nspAddr+"/rest-gateway/rest/api/v1/auth/revocation";
			fetch(url, {
				method: "POST",
				headers: {
					"Content-Type":  "application/x-www-form-urlencoded",
					"Authorization": "Basic " + base64.encode(this.username+ ":" +this.password)
				},
				body: "token="+token+"&token_type_hint=token"
			})
			.then((response:any) => {
				this.pluginLogs.info("[WFM]: POST", url, response.status);
			});
		}
	}


	/**
	 * Private wrapper method to call NSP APIs. Method sets http request timeout.
	 * Common error handling and logging is centralized here.
	 * 
	 * @param {string} url API endpoint for http request
	 * @param {{method: string, body: string, headers: object, signal: AbortSignal}} options HTTP method, header, body
	 */	

	private async _callNSP(url:string, options:{method: string, body?: string, headers?: object, signal?: AbortSignal}): Promise<void> {
		this.pluginLogs.info("[WFM]: _callNSP("+url+")");
		const timeout = new AbortController();
        const fetch = require('node-fetch');
		setTimeout(() => timeout.abort(), this.timeout*1000); // in seconds
		options.signal = timeout.signal;

		if (!('headers' in options)) {
			await this._getAuthToken();
			const token = await this.authToken;
			if (!token)
				throw vscode.FileSystemError.Unavailable('NSP is not reachable');

			if (url.startsWith('/restconf')) {
				options.headers = {
					"Content-Type": "application/yang-data+json",
					"Accept": "application/yang-data+json",
					"Authorization": "Bearer " + token
				};
				// leave the if-else block to avoid setting headers twice
			} else if (options.method === 'POST' || (options.method === 'PUT' && !(url.endsWith('/status') || url.endsWith('/ui')))) {
				options.headers = {
					'Content-Type': 'text/plain',
					'Cache-Control': 'no-cache',
					'Authorization': 'Bearer ' + token
				}
			} else if (options.method === 'GET' || options.method === ' DELETE') {
				options.headers = {
					'Cache-Control': 'no-cache',
					'Authorization': 'Bearer ' + token
				}
			} else if ((url.endsWith('/status') || url.endsWith('/ui')) && options.method === 'PUT') {
				options.headers = {
					'Content-Type': 'application/json',
					'Cache-Control': 'no-cache',
					'Authorization': 'Bearer ' + token
				}
			} else {
				options.headers = {
					'Content-Type': "application/json",
					'Accept': "application/json",	
					"Authorization": "Bearer " + token
				};
			}
		}

		if (!url.startsWith('https://')) {
			if (["443",""].includes(this.port))
				url = "https://"+this.nspAddr+url;
			else if (url.startsWith('/logviewer'))
				url = "https://"+this.nspAddr+url;
			else if (this.port != "8545")
				url = "https://"+this.nspAddr+":"+this.port+url;
			else if (url.startsWith('/restconf'))
				url = "https://"+this.nspAddr+":8545"+url;
			else
				// in case of /mdt/rest/...
				url = "https://"+this.nspAddr+":8547"+url;
		}

		const startTS = Date.now();
		const response: any = new Promise((resolve, reject) => {
			fetch(url, options).then((response:any) => {
				response.clone().text().then((body:string) => {
					const duration = Date.now()-startTS;

					this.pluginLogs.info(options.method, url, options.body??"", "finished within", duration, "ms");
					if (response.status >= 400)
						this.pluginLogs.warn("NSP response:", response.status, body);
					else if ((body.length < 1000) || (this.pluginLogs.logLevel == vscode.LogLevel.Trace))
						this.pluginLogs.info("[WFM]: NSP response:", response.status, body);
					else
						this.pluginLogs.info("[WFM]: NSP response:", response.status, body.substring(0,1000)+'...');
				});
				return response;
			})
			.then((response:any) => {
				resolve(response);
			})
			.catch((error:any) => {
				const duration = Date.now()-startTS;
				let errmsg = options.method+" "+url+" failed with "+error.message+" after "+duration.toString()+"ms!";
				if (error.message.includes("user aborted"))
					errmsg = "No response for "+options.method+" "+url+". Call terminated after "+duration.toString()+"ms.";
				this.nspVersion = undefined;
				this.authToken = undefined;
				this._eventEmiter.fire(vscode.Uri.parse('wfm:/'));
				this.pluginLogs.error(errmsg);
				vscode.window.showErrorMessage(errmsg);
				resolve(undefined);
			});
		});
		return response;
	}

	/**
	 * Retrieve and store NSP release in this.nspVersion.
	 * Release information will be shown to vsCode user.
	 * Note: currently used to select OpenSearch API version
	*/	
	private async _getNSPversion(): Promise<void> {
		this.pluginLogs.info("[WFM]: Requesting NSP version");
		const url = "https://"+this.nspAddr+"/internal/shared-app-banner-utils/rest/api/v1/appBannerUtils/release-version";
		this.pluginLogs.info("[WFM]: GET", url);
		let response: any = await this._callNSP(url, {method: "GET"});
		if (!response)
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		if (!response.ok)
			this.pluginLogs.info("[WFM]: NSP version request failed with", response.status);
		let json : any = await response.json();		
		this.nspVersion = json.response.data.nspOSVersion.match(/\d+\.\d+(?=\.\d+)/)[0];
		this.pluginLogs.info("[WFM]: NSP version:", this.nspVersion);

		this._eventEmiter.fire(vscode.Uri.parse('wfm:/'));

		this.pluginLogs.info("[WFM]: Requesting OSD version");
		response = await this._callNSP("/logviewer/api/status", {method: "GET"});
		if (!response)
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP logviewer (opensearch)");
		if (!response.ok) {
			const text: string = await response.text();
			throw vscode.FileSystemError.Unavailable(text);
		}
		json = await response.json();
		this.osdVersion = json.version.number;

		vscode.window.showInformationMessage("Connected to "+this.nspAddr+", NSP version: "+this.nspVersion+", OSD version: "+this.osdVersion);
	}


	/**
	 * Checks if NSP is running at least a specific release
	 * @param {number} major Major NSP REL
	 * @param {number} minor Minor NSP REL
	*/
	private _fromRelease(major: number, minor:number): boolean {
		if (this.nspVersion) {
			if (this.nspVersion[0] > major){ 
				return true;
			}
			if (this.nspVersion[0]===major && this.nspVersion[1]>=minor) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Method to validate NSP credentials
	 * @param {string} ip - IP address of the NSP
	 * @param {string} username - NSP username
	 * @param {string} password - NSP password
	*/
	private async validateNSPCredentials(ip: string, username: string, password: string): Promise<boolean> {

		this.pluginLogs.info("[WFM]: validateIpCredentials()");
		const fetch = require('node-fetch');
		const base64 = require('base-64');
		const timeout = new AbortController();
		setTimeout(() => timeout.abort(), this.timeout);

		const url = "https://"+ip+"/rest-gateway/rest/api/v1/auth/token";
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': 'no-cache',
					'Authorization': 'Basic ' + base64.encode(username+ ":" +password)
				},
				body: '{"grant_type": "client_credentials"}',
				signal: timeout.signal
			});
			if (!response.ok) {
				return false;
			}
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Custom implementation of remove an object from an array by id.
	 * @param {Array} arr Array to remove object from
	 * @param {string} id ID of object to remove
	**/
	private removeObjectByIp(arr, ip) {
		return arr.filter(function(obj) { return obj.ip !== ip; });
	}


	/**
	 * Method to update workflow documentation to NSP
	 * @param {vscode.Uri} uri - URI of the file to be read
	 * @param {string} data - data to be written to the file
	*/
	private async _writeWorkflowDocumentation(uri: vscode.Uri, data: string): Promise<void> {
		this.pluginLogs.info('[WFM]: writeWorkflowDocumentation('+ uri +')');

		let name = uri.toString().split("/")[2] + '.md';
		if (name.replace('.md', '.yaml') in this.workflows) { // We are modifying an existing workflow documentation (editor)
			let url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/workflow/"+name.replace('.md', '');
			let response: any = await this._callNSP(url, { method: 'GET'}); // get workflow / action definition
			if (!response){
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			}
			if (!response.ok) {
				throw vscode.FileSystemError.FileNotFound('');
			}
			await this._updateWorkflowDocumentation(name.replace('.md', '.yaml'), data);
		} else {
			throw vscode.FileSystemError.NoPermissions('Workflow documentation can only be added to existing workflows!');
		}
	}

	/**
	 * Method to update workflow documentation to NSP
	 * @param {string} name - name of the file to be updated
	 * @param {string} data - data to be written to the file
	*/
	private async _updateWorkflowDocumentation(name: string, data: string): Promise<void> {
		this.pluginLogs.info('[WFM]: updateWorkflowDocumentation('+name+')');
		
		const id = this.workflows[name].id;
		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/'+id+'/readme';
		let response: any = await this._callNSP(url, {method: 'PUT', body: data});

		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: PUT", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Workflow upload failed! Reason: '+response.statusText);
		}
		vscode.window.showInformationMessage('Success: Workflow Documentation uploaded to NSP');

		// update workflow documentation cache
		let json = await response.json();
		let entry = json.response.data[0];
		this.workflow_documentations[name.replace('.yaml', '.md')].ctime = Date.parse(entry.created_at);
		this.workflow_documentations[name.replace('.yaml', '.md')].mtime = Date.parse(entry.updated_at);
		this.workflow_documentations[name.replace('.yaml', '.md')].size = entry.details.readme.length;
		this.saveBackupLocally(name, data);
		this.pluginLogs.info('[WFM]: completed updating workflow documentation');
	}

	/**
	 * Method to update workflow Jinja Template to NSP
	 * @param {string} data - data to be validated by NSP
	 */
	private async _validateTemplate(data: string): Promise<void> {
		this.pluginLogs.info('[WFM]: _validateTemplate()');
	
		// validate Template definition
		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/jinja-template/validate';
		let response: any = await this._callNSP(url, { method: 'POST', body: data });
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: POST", url, response.status);
		if (!response.ok) {
			vscode.window.showErrorMessage('Template validation failed!');
		} else {
			let json = await response.json();
			if (json.response.data.valid === 'false') {
				vscode.window.showErrorMessage('Invalid Template Definition:', json.response.data.error);
			} else {
				vscode.window.showInformationMessage('Success: Template validated');
			}
		}
	}

	/**
	 * Method to write a Jinja Template to NSP
	 * @param {string} name - fileName of the file to be written
	 * @param {string} data - data to be written to the file
	*/
	private async _writeTemplate(name: string, data: string): Promise<void> {
		this.pluginLogs.info('[WFM]: writeTemplate()'); // when adding a file if the file does not end with .jinja throw a vscode error and return
		if (!name.endsWith('.jinja')) { // if the newName does not end with .yaml throw a vscode error and return
			throw vscode.FileSystemError.NoPermissions('Jinja Template filename must end with .jinja');
		} else {
			if (name in this.templates) { // We are modifying an existing template (editor)
				// make an api call to get the full template information and then update only the template attribute
				let id = this.templates[name].id;
				let url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/jinja-template/"+id+"/definition";
				let response: any = await this._callNSP(url, { // get workflow / action definition
					method: 'GET'
				});

				if (!response){
					throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
				}

				this.pluginLogs.info("[WFM]: GET", url, response.status);
				if (!response.ok) {
					this.pluginLogs.info(response);
					throw vscode.FileSystemError.FileNotFound('Template not found');
				}

				let text = await response.text();
				const yaml = require('yaml');
				const doc = yaml.parse(text);
				doc.template = data; // update the template attribute

				await this._updateTemplate(name, yaml.stringify(doc));
			} else { // If we are creating a new temlplate
				let data = "---\nname: '"+name.replace('.jinja', '')+"'\ntemplate: ''\ntags: []\ndescription: null\nversion: '1.0.0'\nprovided_by: 'admin'";
				await this._createTemplate(data);
			}
		}
	}

	/**
	 * Method to update a Jinja Template to NSP
	 * @param {string} name - fileName of the file to be updated
	 * @param {string} data - data to be written to the file
	*/
	private async _updateTemplate(name: string, data: string): Promise<void> {
		this.pluginLogs.info('[WFM]: updateTemplate()');
		const id = this.templates[name].id; // get the template id

		// API call to update template:
		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/jinja-template/'+id;
		this.pluginLogs.info('[WFM]: url: ', url);
		let response: any = await this._callNSP(url, {
			method: 'PUT',
			body: data
		});

		if (!response) {
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: PUT", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Template upload failed! Reason: '+response.statusText);
		}
		vscode.window.showInformationMessage('Success: Template uploaded to NSP');

		// update the templates cache
		let json = await response.json();
		const entry =  json.response.data; // access the data attribute from the json
		let defname = entry.name + '.jinja';

		if (name !== defname) {
			vscode.window.showWarningMessage('Template renamed');
			delete this.templates[name];
			const ctime = Date.parse(entry.created_at);
			const mtime = Date.parse(entry.updated_at);
			this.templates[defname] = new FileStat(id, 'file', ctime, mtime, data.length, false);	
			this.readDirectory(vscode.Uri.parse("wfm:/templates"));
		} else {
			this.templates[name].ctime = Date.parse(entry.created_at);
			this.templates[name].mtime = Date.parse(entry.updated_at);
			this.templates[name].size  = data.length;	
		}
		await vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
		this.saveBackupLocally(name, data);
		this.pluginLogs.info('[WFM]: completed updating template');
	}

	/**
	 * Method to create a jinja Template to NSP
	 * @param {string} data - data to be written to the template file
	*/
	private async _createTemplate(data: string): Promise<void> {
		this.pluginLogs.info('[WFM]: _createTemplate()');
		
		// validate template definition
		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/jinja-template/validate';
		let response: any = await this._callNSP(url, {
			method: 'POST',
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: POST", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Template validation failed!');
		}
		let json = await response.json();

		if (json.response.data.valid === 'false') {
			vscode.window.showErrorMessage(json.response.data.error);
			throw vscode.FileSystemError.NoPermissions('Invalid Template Definition');
		}
		vscode.window.showInformationMessage('Success: Template validated');

		// upload new Template
		url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/jinja-template';
		response = await this._callNSP(url, {
			method: 'POST',
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: POST", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Template creation failed! Reason: '+response.statusText);
		}
		vscode.window.showInformationMessage('Success: Template uploaded');

		// update template cache
		json = await response.json();

		// access the data attribute from the json
		const entry =  json.response.data;
		const name = entry.name + '.jinja';
		const id = entry.id;
		const ctime = Date.parse(entry.created_at);
		const mtime = Date.parse(entry.updated_at);
		this.templates[name] = new FileStat(id, 'file', ctime, mtime, data.length, false);

		vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
		vscode.window.showInformationMessage('Success: Template published');
	}

	/**
	 * Method to delete a Jinja Template from NSP
	 * @param {string} name - name of the file to be deleted
	*/
	private async _deleteTemplate(name: string): Promise<void> {
		this.pluginLogs.info('[WFM]: deleteTemplate(+name+)', name);

		const id : string = this.templates[name].id;
		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/jinja-template/'+id.replace('.jinja', '');
		let response: any = await this._callNSP(url, {
			method: 'DELETE'
		});
		if (!response) {
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: DELETE", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Template deletion failed! Reason: '+response.statusText);
		}
		vscode.window.showWarningMessage('Success: Template Deleted!');
		delete this.templates[name]; // update workflow cache
	}
	
	/**
	 * Method to rename a Jinja Template in NSP
	 * @param {string} oldName - old name of the file
	 * @param {string} newName - new name of the file
	*/
	private async _renameTemplate(oldName: string, newName: string): Promise<void> {
		this.pluginLogs.info('[WFM]: renameTemplate()');

		let id = this.templates[oldName].id;
		let url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/jinja-template/"+id+"/definition";
		let response: any = await this._callNSP(url, { // get workflow / action definition
			method: 'GET'
		});

		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: GET", url, response.status);
		if (!response.ok) {
			this.pluginLogs.info(response);
			throw vscode.FileSystemError.FileNotFound('Template not found');
		}

		let text = await response.text();
		const yaml = require('yaml');
		const doc = yaml.parse(text);
		doc.name = newName.replace('.jinja', ''); // update the template attribute
		await this._updateTemplate(oldName, yaml.stringify(doc));
	}

	/**
	 * Method to create a workflow to NSP
	 * @param {string} name - name of the file to be written
	 * @param {string} data - data to be written to the file
	*/
	private async _createWorkflow(temp_name: string, data: string): Promise<void> {
		
		this.pluginLogs.info('[WFM]: createWorkflow()');
		// make a temp folder so VsCode doese't throw up an error in that the folder doesen't exist when created
		this.workflow_folders[temp_name.replace('.yaml', '')] = new FileStat('', 'directory', 0, 0, data.length, false);
		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/validate';
		let response: any = await this._callNSP(url, {
			method: 'POST',
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: POST", url, response.status);
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
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: POST", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Workflow creation failed! Reason: '+response.statusText);
		}
		vscode.window.showInformationMessage('Success: Workflow uploaded');

		// update workflow cache
		json = await response.json();
		const entry =  json.response.data[0];
		const name = entry.name + '.yaml';
		const id = entry.id;
		const ctime = Date.parse(entry.created_at);
		const mtime = Date.parse(entry.updated_at);
		this.workflow_folders[name.replace('.yaml', '')] = new FileStat(id, 'directory', ctime, mtime, data.length, false);
		this.workflows[name] = new FileStat(id, 'file', ctime, mtime, data.length, false);
		this.workflow_documentations[name.replace('.yaml', '.md')] = new FileStat(id, 'file', ctime, mtime, data.length, false);
		this.workflow_views[name.replace('.yaml', '.json')] = new FileStat(id, 'file', ctime, mtime, data.length, false);	

		// change to PUBLISHED
		url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/'+id+'/status';
		response = await this._callNSP(url, {
			method: 'PUT',
			body: '{"status": "PUBLISHED"}'
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}
		this.pluginLogs.info("[WFM]: PUT", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Change mode to PUBLISHED failed! Reason: '+response.statusText);
		}
		vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
		vscode.window.showInformationMessage('Success: Workflow published');
		this.pluginLogs.info("[WFM]: completed createWorkflow()");
	}

	/**
	 * Method to update a workflow to NSP
	 * @param {string} name - name of the file to be updated
	 * @param {string} data - data to be written to the file
	 * @param {boolean} rename - flag to rename the workflow
	*/
	private async _updateWorkflow(name: string, data: string, rename: boolean): Promise<void> {
		this.pluginLogs.info("[WFM]: updateWorkflow(" + name + ")");

		const yaml = require('yaml');
		let defname = Object.keys(yaml.parse(data)).filter((value) => value !== "version")[0] + '.yaml';
		if ((defname !== name) && (!rename)) { // If the name in the definition is different from the filename and not a rename
			if (Object.keys(this.workflows).indexOf(defname)=== -1) { // if the  name is not in the workflows
				vscode.window.showInformationMessage('Workflow Name changed, creating new workflow.');
				await this._createWorkflow(defname, data);
				let txtdoc = await vscode.workspace.openTextDocument( vscode.Uri.parse("wfm:/workflows/" + defname.replace('.yaml','') + "/" +defname));
				vscode.window.showTextDocument(txtdoc);
			} else {
				vscode.window.showErrorMessage("Cloning to an existing Workflow name is not allowed!");
			}
		} else if (this.workflows[name].signed) {
			vscode.window.showErrorMessage("Unable to save SIGNED workflow. To create a copy, modify the name in the definition.");
		} else { // if we need to rename
			// validate workflow definition
			let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/validate';
			let response: any = await this._callNSP(url, {
				method: 'POST',
				body: data
			});
			if (!response){
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			}

			this.pluginLogs.info("[WFM]: POST", url, response.status);
			if (!response.ok) {
				throw vscode.FileSystemError.Unavailable('Workflow validation failed!');
			}
			let json = await response.json();
			if (json.response.data.valid === 'false') {
				vscode.window.showErrorMessage(json.response.data.error);
				throw vscode.FileSystemError.NoPermissions('Invalid Workflow Definition');
			}
			vscode.window.showInformationMessage('Success: Workflow validated');

			let id: string;
			if (!name.includes('.yaml')) {
				id = this.workflows[name + '.yaml'].id;
			} else {
				id = this.workflows[name].id;
			}
			// change to DRAFT
			url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/'+id+'/status';
			this.pluginLogs.info('[WFM]: url: ', url);
			response = await this._callNSP(url, {
				method: 'PUT',
				body: '{"status": "DRAFT"}'
			});
			if (!response){
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			}

			this.pluginLogs.info("[WFM]: PUT", url, response.status);
			if (!response.ok) {
				throw vscode.FileSystemError.Unavailable('Change mode to DRAFT failed!');
			}
			vscode.window.showInformationMessage('Success: Enabled DRAFT mode');

			// upload workflow
			url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/'+id+'/definition';
			this.pluginLogs.info('[WFM]: url: ', url);
			response = await this._callNSP(url, {
				method: 'PUT',
				body: data
			});
			if (!response){
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			}

			this.pluginLogs.info("[WFM]: PUT", url, response.status);
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
				this.workflows[defname] = new FileStat(id, 'file', ctime, mtime, data.length, false);
				this.pluginLogs.info('[WFM]: defName in workflows', defname);	
				this.readDirectory(vscode.Uri.parse("wfm:/workflows/"));
			} else { // here we update the workflow cache
				this.workflows[name].ctime = Date.parse(entry.created_at);
				this.workflows[name].mtime = Date.parse(entry.updated_at);
				this.workflows[name].size  = data.length;
				this.workflow_folders[name.replace('.yaml', '')].ctime = Date.parse(entry.created_at);
				this.workflow_folders[name.replace('.yaml', '')].mtime = Date.parse(entry.updated_at);
				this.readDirectory(vscode.Uri.parse("wfm:/workflows/"));
			}

			// change to PUBLISHED
			url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/'+id+'/status';
			response = await this._callNSP(url, {
				method: 'PUT',
				body: '{"status": "PUBLISHED"}'
			});
			if (!response) {
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			}

			this.pluginLogs.info("[WFM]: PUT", url, response.status);
			if (!response.ok) {
				throw vscode.FileSystemError.Unavailable('Change mode to PUBLISHED failed!');
			}
			vscode.window.showInformationMessage('Success: Workflow published');
			await vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
			this.saveBackupLocally(name, data);
		}
		this.pluginLogs.info('[WFM]: completed updating workflow');
	}

	/**
	 * Method to delete a workflow from NSP
	 * @param {string} name - name of the file to be deleted
	*/
	private async _deleteWorkflow(name: string): Promise<void> {
		this.pluginLogs.info('[WFM]: deleteWorkflow()');
		
		if (this.workflows[name+'.yaml'].signed) {
			throw vscode.FileSystemError.NoPermissions('Unable to delete SIGNED workflows');
		}

		const id : string = this.workflows[name+'.yaml'].id;

		// change to DRAFT
		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/'+id+'/status';
		let response: any = await this._callNSP(url, {
			method: 'PUT',
			body: '{"status": "DRAFT"}'
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: PUT", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Change mode to DRAFT failed! Reason: '+response.statusText);
		}
		vscode.window.showInformationMessage('Success: Enabled DRAFT mode');

		// delete workflow
		url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/'+id;
		response = await this._callNSP(url, {
			method: 'DELETE'
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}
		this.pluginLogs.info("[WFM]: DELETE", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Workflow deletion failed! Reason: '+response.statusText);
		}
		vscode.window.showWarningMessage('Success: Workflow Deleted!');
		// update workflow cache: When a workflow is deleted its documentation is also deleted
		delete this.workflows[name];
		delete this.workflow_documentations[name.replace('.yaml', '.md')];
		delete this.workflow_views[name.replace('.yaml', '.json')];
		delete this.workflow_folders[name.replace('.yaml', '')];
	}

	/**
	 * Method to validate a workflow by calling the NSP and checking if the workflow is valid
	 * @param {string} data - data to be validated by NSP
	 */
	private async _validateWorkflow(data: string): Promise<void> {
		this.pluginLogs.info('[WFM]: _validateWorkflow()');

		// validate workflow definition
		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/validate';
		let response: any = await this._callNSP(url, {
			method: 'POST',
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: POST", url, response.status);
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

	/**
	 * Method to write a workflow view to NSP
	 * @param {string} name - name of the file to be written
	 * @param {string} data - data to be written to the file
	 */
	private async _writeWorkflowView(name: string, data: string): Promise<void> {
		this.pluginLogs.info('[WFM]: writeWorkflowView()');
		
		if (name.replace('.json', '.yaml') in this.workflows) { // We are modifying an existing workflow documentation (editor)
			// make an api call to get the full view info and then update only the data attribute
			let id = this.workflows[name.replace('.json', '.yaml')].id;
			let url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/workflow/"+id+"/ui";
			let response: any = await this._callNSP(url, { // get workflow / action definition
				method: 'GET'
			});

			if (!response){
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			}

			this.pluginLogs.info("[WFM]: GET", url, response.status);
			if (!response.ok) {
				throw vscode.FileSystemError.FileNotFound('');
			}
			await this._updateWorkflowView(name.replace('.json', '.yaml'), data);
		} else { // adding a new workflow documentation.
			throw vscode.FileSystemError.NoPermissions('Workflow Views can only be added to existing workflows!');
		}
	}

	/**
	 * Method to update a workflow view to NSP
	 * @param {string} name - name of the file to be updated
	 * @param {string} data - data to be written to the file

	*/
	private async _updateWorkflowView(name: string, data: string): Promise<void> {

		this.pluginLogs.info('[WFM]: updateWorkflowView()');
		const id = this.workflows[name].id;
		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/workflow/'+id+'/ui'; 
		let response: any = await this._callNSP(url, {
			method: 'PUT',
			body: JSON.stringify(data)
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: PUT", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Workflow upload failed! Reason: '+response.statusText);
		}
		vscode.window.showInformationMessage('Success: Workflow View uploaded to NSP');

		// update workflow view cache
		let json = await response.json();
		let entry = json.response.data;
		this.saveBackupLocally(name, data);
	}

	/**
	 * Method to write a workflow to NSP
	 * @param {string} name - name of the file to be written
	 * @param {string} data - data to be written to the file
	 */
	private async _writeWorkflow(name: string, data: string): Promise<void> {
		this.pluginLogs.info('[WFM]: writeWorkflow('+name+')');
		if (!name.endsWith('.yaml')) { // if the newName does not end with .yaml throw a vscode error and return
			throw vscode.FileSystemError.NoPermissions('Workflow filename must end with .yaml');
		} else {
			if (name in this.workflows) {
				await this._updateWorkflow(name, data, false);
			} else {
				if (data.length === 0) {
					data = "---\nversion: '2.0'\n\n"+name.replace('.yaml', '')+":\n  type: direct\n\n  description: this is a new workflow\n  \n  tags:\n    - demo\n\n  input:\n    - number1: 1234\n    - number2: 123\n    - ipAddress: '127.0.0.1'\n    - someText: 'my default value'\n    - pass: false\n    - delay: 1\n    - passRatio: 30\n\n  output:\n    devices: <% $.nodeList %>\n    sysinfo: <% $.sysInfo %>\n    rttinfo: <% $.rttInfo %>\n    time: <% $.timeInfo %>\n    \n  output-on-error:\n    result: 'Error occured, check logs for details'\n\n  tasks:\n    task1:\n      action: std.echo\n      input:\n        output:\n          someMath: <% $.number1 - $.number2 %>\n      publish:\n        randomNbr: <% 100*random() %>\n      on-success:\n        - pingLocalHost\n\n    pingLocalHost:\n      action: nsp.ping\n      input:\n        host: 127.0.0.1\n        duration: 1\n      publish:\n        rttInfo: <% task().result.RTT %>\n      on-success:\n        - getPythonVersionAndModules\n        - getTimestamp\n        - getNodes\n      on-error:\n        - fail\n\n    getNodes:\n      action: nsp.https\n      input:\n        url: 'https://restconf-gateway/restconf/operations/nsp-inventory:find'\n        method: POST\n        body: \n          input:\n            xpath-filter: /nsp-equipment:network/network-element\n            offset: 0\n            limit: 100\n            fields: ne-id;ne-name;ip-address;version;location;type;product\n            sort-by:\n              - ne-name\n      publish:\n        nodeList: <% task().result.content['nsp-inventory:output'] %>\n      on-complete:\n        - continue\n\n    getPythonVersionAndModules:\n      action: nsp.python\n      input:\n        context: <% $ %>\n        script: |\n          import sys\n          import platform\n          import pkg_resources\n\n          rvalue = {}\n          rvalue['sys.version']=sys.version\n          rvalue['platform.python_version']=platform.python_version()\n          rvalue['packages'] = sorted(['%s==%s' % (i.key, i.version) for i in pkg_resources.working_set])\n\n          return rvalue\n      publish:\n        sysInfo: <% task().result %>\n      on-complete:\n        - continue\n\n    getTimestamp:\n      action: std.js\n      input:\n        script: |\n          function getTS() {\n            const date = new Date();\n            let now = date.getTime();\n            return now;\n          }\n          return getTS();\n      publish:\n        timeInfo: <% task().result %>\n      on-complete:\n        - continue\n        \n    continue:\n      join: all    \n      action: std.noop\n      on-success:\n        - randomFailure: <% not $.pass %>\n        - done: <% $.pass %>\n        \n    randomFailure:\n      action: nsp.assert\n      input:\n        input: <% $.randomNbr < $.passRatio %>\n        expected: true\n        shouldFail: true\n      publish:\n        result: 'I am happy'\n      publish-on-error:\n        result: 'I am unhappy'\n      on-error:\n        - handleFailure\n      on-success:\n        - done\n\n    handleFailure:\n      action: std.sleep\n      input:\n        seconds: <% $.delay %>\n      on-success:\n        - done\n\n    done:\n      action: std.noop\n";
				}
				this._createWorkflow(name, data);
			}
		}
	}
	
	/**
	 * Method to rename a workflow in NSP
	 * @param {string} oldName - old name of the file
	 * @param {string} newName - new name of the file
	*/
	private async _renameWorkflow(oldName: string, newName: string): Promise<void> {

		this.pluginLogs.info("[WFM]: renameWorkflow(" + oldName + ", " + newName + ")");
		const yaml = require('yaml');
		
		// get workflow definitions
		let url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/workflow/"+oldName.replace('.yaml', '') +"/definition";
		let response: any = await this._callNSP(url, {
			method: 'GET'
		});

		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}
		this.pluginLogs.info("[WFM]: GET", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.FileNotFound();
		}

		// update workflow definition
		let text = await response.text();
		let content = yaml.parse(text);
		content[newName.replace('.yaml', '')] = content[oldName.replace('.yaml', '')];
		delete content[oldName.replace('.yaml', '')];
		await this._updateWorkflow(oldName, yaml.stringify(content), true); // update workflow
	}

	/**
	 * Method to create an action to NSP
	 * @param {string} data - data to be written to the file
	*/
	private async _createAction(data: string): Promise<void> {
		this.pluginLogs.info('[WFM]: createAction()');

		// validate action definition
		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/action/validate';
		let response: any = await this._callNSP(url, {
			method: 'POST',
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: POST", url, response.status);
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
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: POST", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Action creation failed! Reason: '+response.statusText);
		}
		vscode.window.showInformationMessage('Success: Action uploaded');

		json = await response.json();
		const entry = json.response.data[0];
		const name = entry.name + '.action';
		const id = entry.id;
		const ctime = Date.parse(entry.created_at);
		const mtime = Date.parse(entry.updated_at);
		this.actions[name] = new FileStat(id, 'file', ctime, mtime, data.length, false);
		vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
	}

	/**
	 * Method to update an action to NSP
	 * @param {string} name - name of the file to be updated
	 * @param {string} data - data to be written to the file
	*/
	private async _updateAction(name: string, data: string, rename: boolean): Promise<void> {
		this.pluginLogs.info('[WFM]: _updateAction()');

		const yaml = require('yaml');
		let defname = Object.keys(yaml.parse(data)).filter((value) => value !== "version")[0] + '.action';
		if ((defname !== name) && (!rename)) { // If the name in the definition is different from the filename and not a rename
			if (Object.keys(this.actions).indexOf(defname)=== -1) { // if the  name is not in the actions
				vscode.window.showInformationMessage('Action Name changed, creating copy of action.');
				await this._createAction(data);
				let txtdoc = await vscode.workspace.openTextDocument( vscode.Uri.parse("wfm:/actions/" + defname));
				vscode.window.showTextDocument(txtdoc);
			} else {
				vscode.window.showErrorMessage("Cloning to an existing Action name is not allowed!");
			}
		} else if (this.actions[name].signed) {
			vscode.window.showErrorMessage("Unable to save SIGNED Action. To create a copy, modify the name in the definition.");
		} else { // if we need to rename or were just updating
			const id = this.actions[name].id;

			// validate action definition
			let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/action/validate';
			let response: any = await this._callNSP(url, {
				method: 'POST',
				body: data
			});
			if (!response){
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			}

			this.pluginLogs.info("[WFM]: POST", url, response.status);
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
				body: data
			});
			if (!response){
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			}

			this.pluginLogs.info("[WFM]: PUT", url, response.status);
			if (!response.ok) {
				throw vscode.FileSystemError.Unavailable('Action upload failed! Reason: '+response.statusText);
			}
			vscode.window.showInformationMessage('Success: Action uploaded');

			// update action cache
			json = await response.json();
			const entry = json.response.data[0];

			if (name !== entry.name + '.action') {
				vscode.window.showWarningMessage('Action renamed');
				delete this.actions[name];
				name = entry.name + '.action';
				const ctime = Date.parse(entry.created_at);
				const mtime = Date.parse(entry.updated_at);
				this.actions[name] = new FileStat(id, 'file', ctime, mtime, data.length, false);			
			} else {
				this.actions[name].ctime = Date.parse(entry.created_at);
				this.actions[name].mtime = Date.parse(entry.updated_at);
				this.actions[name].size  = data.length;
			}
			this.saveBackupLocally(name, data);
		}
	}

	/**
	 * Method to delete an action from NSP
	 * @param {string} name - name of the file to be deleted
	*/
	private async _deleteAction(name: string): Promise<void> {
		this.pluginLogs.info('[WFM]: deleteAction(+name+)', name);
		const id : string = this.actions[name].id;

		// delete action
		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/action/'+id;
		let response: any = await this._callNSP(url, {
			method: 'DELETE'
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: DELETE", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Action deletion failed! Reason: '+response.statusText);
		}
		vscode.window.showWarningMessage('Success: Action Deleted!');
		delete this.actions[name]; // update action cache
	}

	/**
	 * Method to validate an action by calling the NSP and checking if the action is valid
	 * @param {string} data - data to be validated by NSP
	*/
	private async _validateAction(data: string): Promise<void> {
		this.pluginLogs.info('[WFM]: _validateAction()');

		// validate action definition
		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/action/validate';
		let response: any = await this._callNSP(url, {
			method: 'POST',
			body: data
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: POST", url, response.status);
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

	/**
	 * Method to write an action to NSP
	 * @param {string} name - name of the file to be written
	 * @param {string} data - data to be written to the file
	*/
	private async _writeAction(name: string, data: string): Promise<void> {
		this.pluginLogs.info('[WFM]: _writeAction()');
		if (!name.endsWith('.action')) { // if the newName does not end with .yaml throw a vscode error and return
			throw vscode.FileSystemError.NoPermissions('Action filename must end with .action');
		} else{
			if (name in this.actions) {
				await this._updateAction(name, data, false);
			} else {
				if (data.length === 0) {
					data = "---\nversion: '2.0'\n\n"+name.replace('.action' ,'')+":\n  description: |\n    action: "+name+"\n  base: nsp.https\n  base-input:\n    url: 'https://restconf-gateway/restconf/operations/nsp-inventory:find'\n    method: POST\n    auth: <% $.token_auth %>      \n    body: \n      input:\n        xpath-filter: /nsp-equipment:network/network-element<% xpath_filter($.formValues.get('filter')) %>\n        offset: <% $.formValues.get('offset') %>\n        limit: <% $.formValues.get('limit') %>\n        fields: ne-id;ne-name;ip-address;version;location;type;product\n        sort-by:\n          - ne-id\n  input:\n    - token_auth\n    - formValues: {}\n  output: <% $.content['nsp-inventory:output'] %>\n";
				}
				await this._createAction(data);
			}
		}
	}

	/**
	 * Method to rename an action in NSP
	 * @param {string} oldName - old name of the file
	 * @param {string} newName - new name of the file
	*/
	private async _renameAction(oldName: string, newName: string): Promise<void> {
		this.pluginLogs.info('[WFM]: renameAction()');
		const yaml = require('yaml');

		// get action definitions
		let url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/action/"+oldName.replace('.action','')+"/definition";
		let response: any = await this._callNSP(url, {
			method: 'GET'
		});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: GET", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.FileNotFound();
		}

		// update action definition
		let text = await response.text();
		let content = yaml.parse(text);
		content[newName.replace('.action','')] = content[oldName.replace('.action','')];
		delete content[oldName.replace('.action','')];

		await this._updateAction(oldName, yaml.stringify(content), true); // update workflow
	}

	/**
	 * Method to get html webView content for workflow execution report
	 * @param {string} wfnm - name of the workflow
	 * @param {string} exectime - time of execution
	 * @param {string} execstat - status of execution
	 * @param {string} execid - id of the execution
	 * @param {string} state_info - state information
	 * @param {vscode.WebviewPanel} panel - webview panel
	*/
	private async _getWebviewContent(wfnm: string, exectime: string,execstat: string,execid: string,state_info: string,panel: vscode.WebviewPanel): Promise<string> {
		this.pluginLogs.info('[WFM]: _getWebviewContent()');

		const isNSPVersion2311 = this._fromRelease(23, 11);
		const nspAddr = this.nspAddr;
		const port = this.port;
		this.pluginLogs.info('[WFM]: isNSPVersion2311: ', isNSPVersion2311);
		const extURI = this.extContext.extensionUri;
		const onDiskPath = vscode.Uri.joinPath(extURI, 'media', 'noklogo_black.svg');
		const catGifSrc = panel.webview.asWebviewUri(onDiskPath);
		const codiconsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extURI, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'));
		let html=`<!doctype html><html><head><title>WFM Report</title><meta name="description" content="WFM Execution report"><meta name="keywords" content="WFM execution report"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@100;300&display=swap" rel="stylesheet"><link href="`+codiconsUri+`" rel="stylesheet" /><style>*{ box-sizing: border-box; -webkit-box-sizing: border-box; -moz-box-sizing: border-box;}body{ font-family: 'Poppins', sans-serif; -webkit-font-smoothing: antialiased; background-color: #F8F8F8;}h2{ font-family: 'Poppins', sans-serif; text-align: left; font-size: 14px; letter-spacing: 1px; color: #555; margin: 20px 3%; width: 94%;}h3{ font-family: 'Poppins', sans-serif; text-align: left; font-size: 14px; letter-spacing: 1px; color: #555; margin: 20px 3%; width: 94%;}.publish { height: 100px; width: 100%; overflow-y: auto; }.nokia { display: block; margin-left: auto; margin-right: auto; margin-top: 100px; width: 30%;}.icon { width: 10px; margin-right: 0px;}.accordion > input[type="checkbox"] { position: absolute; left: -100vw;}.accordion .content { overflow-y: hidden; height: 0; transition: height 0.3s ease;}.accordion > input[type="checkbox"]:checked ~ .content { height: auto; overflow: visible;}.accordion label { display: block;}/* Styling*/body { font: 16px/1.5em "Overpass", "Open Sans", Helvetica, sans-serif; color: #333; font-weight: 300;}.accordion { margin-bottom: 1em; margin-left: 3%; width: 94%;}.accordion > input[type="checkbox"]:checked ~ .content { background: #F0F0F0 ; padding: 15px; border-bottom: 1px solid #9E9E9E;}.accordion .handle { margin: 0; font-size: 15px; line-height: 1.2em; width: 100%;}.accordion label { color: #555; cursor: pointer; font-weight: normal; padding: 15px; background: #F8F8F8; border-bottom: 1px solid #9E9E9E;}.accordion label:hover,.accordion label:focus { background: #BEBEBE; color: #001135;font-weight: 500;}/* Demo purposes only*/*,*:before,*:after { box-sizing: border-box;}body { padding: 40px;}a { color: #06c;}p { margin: 0 0 1em; font-size: 13px;}h1 { margin: 0 0 1.5em; font-weight: 600; font-size: 1.5em;}.accordion { max-width: 65em;}.accordion p:last-child { margin-bottom: 0;}</style></head><body><td><img class="nokia" src="`+catGifSrc+`"></td>`;
		html=html+`<h2>Workflow: `+wfnm+`</h2><h2>Execution: `+execid+`</h2><h3>Status: `+execstat+` at `+exectime+`</h3>`;
		if (execstat==="ERROR") html=html+`<h3>`+state_info+`</h3>`;
		
		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }
		
		let url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/task/execution/"+execid;
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
			
			if (taskstat === "RUNNING") { // change this url to the correct one, no hardcoding
				if (isNSPVersion2311) {
					html=html+`<a href="https://`+nspAddr+`/web/workflow-manager/workflow-executions/tasks/action-executions?workflowId=`+wfnm+`&wfExecutionId=`+execid+`&taskId=`+taskid+`">See in WFM</a>`;
				} else {
					html=html+`<a href="https://`+nspAddr+`:`+port+`/workflow-manager/executions/`+execid+`/tasks/`+taskid+`">See in WFM</a>`;
				}
			}
			html=html+`</div></section>`;
			i=i+1;
			this.pluginLogs.info(JSON.stringify(publish, undefined, 4));
		});
		html=html+`</body></html>`;
		return html;
	}


	/**
	 * Method to validate workflows, actions and templates in the editor
	*/
	async validate(): Promise<void> {

		this.pluginLogs.info("[WFM]: validate()");
		const YAML = require('yaml')
		const editor = vscode.window.activeTextEditor;

		if (editor) {
			const uri = vscode.window.activeTextEditor?.document.uri.toString();
			if (uri?.startsWith('wfm:/workflows/')) {
				this._validateWorkflow(editor.document.getText());
			} else if (uri?.startsWith('wfm:/actions/')) {
				this._validateAction(editor.document.getText());
			} else if (uri?.startsWith('wfm:/templates/')) {
				this._validateTemplate(editor.document.getText());
			} else { // if the uri is not in the workflow manager
				let doc = YAML.parse(editor.document.getText());
				let key = Object.keys(doc).filter((value) => value !== "version")[0];
				if ('base-input' in doc[key+'.yaml']) { // if the key is in the actions 
					this._validateAction(editor.document.getText());					
				} else {
					this._validateWorkflow(editor.document.getText());
				}
			}
		}
	}

	/**
	 * Method to Cross launch NSP WebUI.
	 * Works with NSP New Navigation (since 23.11)
	*/
	async openInBrowser(): Promise<void> { // async function to open the workflow in the browser
		this.pluginLogs.info("[WFM]: openInBrowser()");
		const YAML = require('yaml')
		const editor = vscode.window.activeTextEditor; // gets the active file that the user is in.

		let prefix = '';
		let isNSPVersion2311 = false;
		if (this._fromRelease(23,11)) {
			prefix = "https://"+this.nspAddr+"/web/workflow-manager"; // url for new navigation since NSP 23.11
			isNSPVersion2311 = true;
		} else {
			prefix = "https://"+this.nspAddr+":"+this.port+'/workflow-manager'; // url for old navigation before NSP 23.11
			isNSPVersion2311 = false;
		}
		
		if (editor) {
			var uri = vscode.window.activeTextEditor?.document.uri.toString(); // gets it uri
			if (uri?.startsWith('wfm:/workflows/')) { // if the active file is in workflows
				const key = uri.split("/").pop().replace('.yaml', '');
				let url = '';
				if (isNSPVersion2311) {
					url = prefix+"/workflows/info?workflowId="+key;
				} else {
					url = prefix+"/workflows/"+key;
				}
				vscode.env.openExternal(vscode.Uri.parse(url));
			} else if (uri?.startsWith('wfm:/actions/')) { // if the active file is in actions
				uri = uri.replace('.action', '')
				const key = uri.toString().substring(13);
				let url = '';
				if (isNSPVersion2311) {
					url = prefix+"/actions/update?actionId="+key;
				} else {
					url = prefix+"/actions/"+key;
				}
				vscode.env.openExternal(vscode.Uri.parse(url));
			} else if (uri?.startsWith('wfm:/templates/')) {
				uri = uri.replace('.jinja', '')
				const key = uri.toString().substring(15);
				let url = '';
				if (isNSPVersion2311) {
					url = prefix+"/jinja-template/update?jinjaName="+key;
				} else {
					url = prefix+"/jinjatemplate/"+key;
				}
				vscode.env.openExternal(vscode.Uri.parse(url));
			} else { // if the active file is in neither
				let doc = YAML.parse(editor.document.getText());
				let key = Object.keys(doc).filter((value) => value !== "version")[0];
				if ('base-input' in doc[key]) {
					if (Object.keys(this.actions).length === 0) {
						await this.readDirectory(vscode.Uri.parse('wfm:/actions'));
					}
					if (key in this.actions) {
						// const url = "https://"+this.nspAddr+":"+this.port+"/workflow-manager/actions/"+key+ '.action';
						let url = '';
						if (isNSPVersion2311) {
							url = prefix+"/actions/update?actionId="+key+ '.action';
						} else {
							url = prefix+"/actions/"+key+ '.action';
						}
						// const url = prefix+"/workflow-manager/actions/"+key+ '.action';
						vscode.env.openExternal(vscode.Uri.parse(url));
					} else {
						vscode.window.showErrorMessage('Need to upload action '+key+' to WFM first!');
					}
				} else {
					if (Object.keys(this.workflows).length === 0) {
						await this.readDirectory(vscode.Uri.parse('wfm:/workflows'));
					}		
					if (key in this.workflows) {
						// const url = "https://"+this.nspAddr+":"+this.port+"/workflow-manager/workflows/"+key+ '.yaml';
						let url = '';
						if (isNSPVersion2311) {
							url = prefix+"/actions/update?actionId="+key+ '.yaml';
						} else {
							url = prefix+"/actions/"+key+ '.yaml';
						}
						// const url = prefix + "/workflow-manager/workflows/"+key+ '.yaml';
						vscode.env.openExternal(vscode.Uri.parse(url));
					} else {
						vscode.window.showErrorMessage('Need to upload workflow '+key+' to WFM first!');
					}
				}
			}
		}
	}

	/**
	 * Method to apply JSON schema to the active text editor
	*/
	async applySchema(): Promise<void>{ // applySchema returns a promise of void
		this.pluginLogs.info("[WFM]: applySchema()");
		const editor = vscode.window.activeTextEditor; // get the active text editor
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
	
	/**
	 * Method to execute a workflow in WFM
	*/
	async execute(): Promise<void>{
		this.pluginLogs.info('[WFM]: execute()');
		const YAML = require('yaml')
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			let ym = YAML.parse(editor.document.getText());
			let wfnm = Object.keys(ym).filter((value) => value !== "version")[0] + '.yaml';
			let id=this.workflows[wfnm].id;
			let inputatt: {[name: string]: string}={};

			let allwfs:JSON = {} as JSON;

			var stringConstructor = "test".constructor;
			var objectConstructor = ({}).constructor;

			vscode.window.showInformationMessage('workflow '+wfnm+' in WFM.');
			
			let attrib: string|undefined="{}";
			if (ym[wfnm.replace('.yaml', '')].hasOwnProperty('input') === true) {
				ym[wfnm.replace('.yaml', '')].input.forEach(function(key){
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

			let execid = data.response.data[0].id;
			vscode.window.showInformationMessage('Workflow '+wfnm+' execution sent',"See in WFM","Cancel").then((selectedItem) => {
				if ('See in WFM' === selectedItem) {
					if (this._fromRelease(23,11)) {
						vscode.env.openExternal(vscode.Uri.parse("https://"+this.nspAddr+"/web/workflow-manager/workflow-executions/info?workflowId="+wfnm+"&wfExecutionId="+execid));
					} else {
						vscode.env.openExternal(vscode.Uri.parse("https://"+this.nspAddr+":"+this.port+"/workflow-manager/workflows/"+wfnm+"/executions/"+execid));
					}
				}
			});
		}
	}

	/**
	 * Method to execute the last workflow in WFM
	*/
	async lastResult(): Promise<void> {
		this.pluginLogs.info('[WFM]: lastResult()');
		const YAML = require('yaml');
		const fetch = require('node-fetch');

		const editor = vscode.window.activeTextEditor;
		if (editor) {
			vscode.window.showInformationMessage('Retrieving Last Execution Result.');

			await this._getAuthToken(); // get auth-token
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
			let aux = data.response.data.pop()
			let exectime = aux.updated_at;
			let execstat = aux.state;
			let execid = aux.id;
			let state_info = aux.state_info;
			var path = require('path');
			vscode.window.showInformationMessage('Last execution info:'+exectime+"\nwith status: "+execstat,"See in WFM","Details","Cancel").then( async (selectedItem) => {
				if ('Details' === selectedItem) { //Beta
					this.pluginLogs.info(path.join(this.extContext.extensionPath, 'media'));
					const panel = vscode.window.createWebviewPanel(
						'executionReport',
						wfnm+' Execution',
						vscode.ViewColumn.Two,
						{localResourceRoots: 
							[vscode.Uri.file(path.join(this.extContext.extensionPath, 'media')), vscode.Uri.file(path.join(this.extContext.extensionPath, 'node_modules'))]}
					);
					panel.webview.html = await this._getWebviewContent(wfnm,exectime,execstat,execid,state_info,panel);
				} else if ('See in WFM' === selectedItem){
					if (this._fromRelease(23,11)) {
						vscode.env.openExternal(vscode.Uri.parse("https://"+this.nspAddr+"/web/workflow-manager/workflow-executions/info?workflowId="+wfnm+"&wfExecutionId="+aux.id));
					} else {
						vscode.env.openExternal(vscode.Uri.parse("https://"+this.nspAddr+":"+this.port+"/workflow-manager/workflows/"+wfnm+"/executions/"+aux.id));
					}
				}
			});
		}
	}

	/*
	 * Method to upload the active file to NSP
	*/
	async upload(): Promise<void> {
		this.pluginLogs.info('[WFM]: upload()');
		const YAML = require('yaml')
		const editor = vscode.window.activeTextEditor;

		if (editor) { // Note: uses the action/workflow name from local YAML definition
			const doc = editor.document.getText();
			const obj = YAML.parse(doc);
			let key = Object.keys(obj).filter((value) => value !== "version")[0];
			if ('base-input' in obj[key]) {
				this._writeAction(key+".action", doc);
			} else {
				this._writeWorkflow(key+".yaml", doc);
			}
		}
	}

	/**
	 * Method to generate the workflow manager schema and snippets
	*/
	async generateSchema(): Promise<void> {
		this.pluginLogs.info('[WFM]: generateSchema()');
		let data;
		await this._getAuthToken(); // get auth-token
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
		let actions = data.response.data;
		let entries: any = {};
		entries["actions"] = [];
		const YAML = require('yaml');
		const ny = require('nunjucks');
		let actionlist = []; // used to store a list of actions
		actions.forEach(function(action) {
			let entry: any = {};
			try {
				let ym = YAML.parse(action.description);
				entry["name"]=action.name;
				if (Object.keys(ym).includes("examples")){ // if the action has examples
					const ex1 = Object.keys(ym.examples)[0];
					snippets[ym.action]={"scope":"yaml","prefix":ym.action,"description":ex1,"body":[ym.examples[ex1]]};
				}
				entry["description"] = ym.short_description.replace("\n", " ").trim(); // parse for the workflow description
				entry["properties"] = ym.input; // parse for the workflow properties

				Object.keys(entry.properties).forEach(function (arg){ // loop through each property
					if (Object.keys(entry.properties[arg]).indexOf("description") !== -1) { // if the argument has a description
						var auxi = entry.properties[arg]["description"].split("\n")[0]; // get the first line of the description
						entry.properties[arg]["description"] = auxi; // set the description to the first line
					}
				});
			} catch { // If the action does not have a description field
				entry["name"]=action.name; // set the name to the action name
				if(Object.keys(action).indexOf("description") === -1 || !(action["description"])){ // if the action does not have a description
					entry["description"] = ""; // set the description to an empty string
				} else if (Object.keys(action.description).indexOf("\n") === -1){ // if the action description does not have a newline
					var auxi = action.description.split("short_description: ")[1]; // get the short description
					if (auxi){ // if the short description exists
						entry["description"] = auxi.split("\n")[0]; // set the description to the short description
					} else {
						entry["description"] = "No description provided"; // set the description to no description provided
					}
				}
				let props:JSON = {} as JSON; // create a JSON object for the properties
				action["input"].split(', ').forEach( function(property_name) { // loop through each property
					if (property_name.indexOf("=") !== -1){ // if the property has a default value
						property_name = property_name.split('=')[0]; // get the property name
						let default_value = property_name.split('=')[1]; // get the default value
					}
					// if we have nsp.https as the action name: The body property type is anything 
					
					if (/^[a-zA-Z].*$/.test(property_name)===true){  // if the property name starts with a letter
						props[property_name] = {}; // set the property name to an empty object
					}
				}); 
				entry["properties"] = props; // set the properties to the properties object
			}
			if (entry.name === "nsp.https") { // if the action is nsp.https allow the body type to be any type:
				entry.properties["body"]["type"] = {"type": ["string", "object", "array", "null"]};
			}
			if (entry.name === "std.echo") { // if the action is std.echo allow the output type to be any type:
				entry.properties["output"]["type"] = {"type": ["string", "object", "null"]};
			}
			if (entry.name === "nsp.assert"){ // if the action is nsp.assert allow the expected type to be any type:
				entry.properties["expected"]["type"] = {"type": ["boolean", "null"]};
			}
			if (entry.name === "std.http") {
				entry.properties["verify"]['type'] = {"type": ["boolean", "null"]};
				entry.properties['headers']['type'] = {"type": ["object", "null"]};
				entry.properties['body'] = {"type": ["string", "object", "null"]}; // add a propert body for this action
			}
			if (actionlist.indexOf(entry.name)===-1) { // if the action is not already in the list
				entries.actions.push(entry); // add the entry to the list of entries
				actionlist.push(entry.name); // add the action to the list of actions
			}
		});

		var res = ny.render(templatePath, entries); // render the template with the entries
		let fs = require("fs");
		fs.writeFile(outpath, res, (err) => { 
			if(err) { 
				this.pluginLogs.error(err);
			}
		});

		fs.writeFile(snippetsfile, JSON.stringify(snippets,null,'\t'), (err) => { 
			if(err) { 
				this.pluginLogs.error(err);
			}
		});

		const wfmSchema = outpath; // get the path to the schema
		const workflowUri = "wfm:/workflows/*/*"; // get the uri for the workflow
		let schemas = vscode.workspace.getConfiguration('yaml').get('schemas'); // get the schemas from the workspace
		if (schemas[wfmSchema]) { // if the schema is already in the schemas
			if (Array.isArray(schemas[wfmSchema])) { // if the schema is an array
				if (schemas[wfmSchema].indexOf(workflowUri) === -1) { // if the workflow uri is not in the schema
					(schemas[wfmSchema] as Array<string>).push(workflowUri); // add the workflow uri to the schema
				}
			} else if (typeof schemas[wfmSchema] === 'string') { // if the schema is a string
				if (schemas[wfmSchema] !== workflowUri) { // if the schema is not the workflow uri
					schemas[wfmSchema] = [schemas[wfmSchema], workflowUri]; // set the schema to an array with the schema and the workflow uri
				}
			}
		} else {
			schemas[wfmSchema] = workflowUri; // set the schema to the workflow uri
		}
		vscode.workspace.getConfiguration('yaml').update('schemas', schemas); // update the schemas
	}

	/**
	 * Method to generate a form for the active workflow view text editor
	*/
	async generateForm(): Promise<void> {
		const yaml = require('yaml');

		const editor = vscode.window.activeTextEditor;

		let doc = editor.document;
		const uri = vscode.window.activeTextEditor?.document.uri.toString();

		let current = editor.document.getText();

		let yamlUri = vscode.Uri.parse(uri.replace(".json",".yaml"));

		let bufferrefContent = await this.readFile(yamlUri);

		let yamlText = bufferrefContent.toString();


		let uiCommon = function (varName) {
			return {
			name: varName,
			title: varName
				.match(/[0-9]+|[A-Z]*[a-z]+|[A-Z]+/g)
				.join(' ')
				.toUpperCase(),
			description: 'description for ' + varName,
			columnSpan: 4,
			newRow: true,
			readOnly: false,
			required: false,
			}
		}

		let uiNumber = function (varName, defaultValue) {
			let uiSpecs = uiCommon(varName)
			uiSpecs['type'] = 'number'
			uiSpecs['default'] = defaultValue
			return uiSpecs
		}

		let uiBoolean = function (varName, defaultValue) {
			let uiSpecs = uiCommon(varName)
			uiSpecs['type'] = 'boolean'
			uiSpecs['default'] = defaultValue
			return uiSpecs
		}

		var uiEnum = function (varName, values) {
			let uiSpecs = uiCommon(varName)
			uiSpecs['type'] = 'enum'
			uiSpecs['enum'] = values
			return uiSpecs
		}

		let uiText = function (varName, defaultValue) {
			let hidden = [
			'PASS',
			'PASSWD',
			'PASSWORD',
			'SECRET',
			'AUTH',
			'AUTHORIZATION',
			'TOKEN',
			'CREDS',
			'CREDENTIALS',
			'LOGIN',
			] // eslint-disable-line max-len

			let uiSpecs = uiCommon(varName)
			if (uiSpecs['title'].split(' ').find((key) => hidden.includes(key))) {
			uiSpecs['type'] = 'password'
			uiSpecs['default'] = defaultValue
			} else {
			uiSpecs['type'] = 'string'
			uiSpecs['default'] = defaultValue

			if (defaultValue) {
				let patterns = [
				// IPv4 address
				'^(?:(?:2(?:[0-4][0-9]|5[0-5])|[0-1]?[0-9]?[0-9])\\.){3}(?:(?:2([0-4][0-9]|5[0-5])|[0-1]?[0-9]?[0-9]))$',
				// IPv4 subnet
				'^(?:(?:2(?:[0-4][0-9]|5[0-5])|[0-1]?[0-9]?[0-9])\\.){3}(?:(?:2([0-4][0-9]|5[0-5])|[0-1]?[0-9]?[0-9]))\\/(?:3[0-2]|[0-2]?[0-9])$', // eslint-disable-line max-len
				// MAC address
				'^(?:(?:[0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2})$',
				'^(?:(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})$',
				// URL
				'^https?:\\/\\/[\\dA-Za-z\\.-]+\\.[A-Za-z\\.]{2,6}(?:[\\/:?=&#][\\dA-Za-z\\.-]+?)*[\\/\\?]?$',
				// Email
				"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$", // eslint-disable-line max-len
				]
				uiSpecs['validations'] = {
				patterns: patterns.filter((p) => RegExp(p).test(defaultValue)),
				}
			}
			}
			return uiSpecs
		}

		var uiList = function (varName) {
			let uiSpecs = uiCommon(varName)
			uiSpecs['type'] = 'list'
			uiSpecs['component'] = {
			input: 'simpleInputPicker',
			list: 'simplePropertyList',
			}
			return uiSpecs
		}

		var uiSelect = function (varName, cbAction, columns) {
			let uiSpecs = uiCommon(varName)
			uiSpecs['type'] = 'list'
			uiSpecs['component'] = { input: 'picker' }
			uiSpecs['suggest'] = { action: cbAction }
			uiSpecs['properties'] = columns.split(',').map(function (key) {
			return { name: key }
			})
			return uiSpecs
		}

		var uiSelectPaged = function (varName, cbAction, columns) {
			let uiSpecs = uiCommon(varName)
			uiSpecs['type'] = 'list'
			uiSpecs['component'] = { input: 'picker' }
			uiSpecs['componentProps'] = {
			isInfinite: true,
			infiniteProps: { datasource: cbAction },
			}
			uiSpecs['properties'] = columns.split(',').map(function (key) {
			return { name: key }
			})
			return uiSpecs
		}

		var uiSuggest = function (varName, cbAction, column) {
			let uiSpecs = uiCommon(varName)
			uiSpecs['type'] = 'string'
			uiSpecs['component'] = { input: 'autoComplete' }
			uiSpecs['suggest'] = { action: cbAction, name: [column] }
			return uiSpecs
		}

		let properties = []
		try {
			let yamlDoc = yaml.parse(yamlText)
			let name = Object.keys(yamlDoc)[1]
			let input = yamlDoc[name]['input']

			for (let i = 0; i < input.length; i++) {
			if (typeof input[i] === 'object') {
				Object.keys(input[i]).forEach(function (key) {
				if (key === 'token_auth') {
					// this.pluginLogs.info('[WFM]: ignore token_auth')
				} else if (typeof input[i][key] === 'string') {
					// this.pluginLogs.info('[WFM]: string or password')
					properties.push(uiText(key, input[i][key]))
				} else if (typeof input[i][key] === 'number') {
					// this.pluginLogs.info('[WFM]: number')
					properties.push(uiNumber(key, input[i][key]))
				} else if (typeof input[i][key] === 'boolean') {
					// this.pluginLogs.info('[WFM]: boolean')
					properties.push(uiBoolean(key, input[i][key]))
				} else if (
					typeof input[i][key] === 'object' &&
					input[i][key] !== null
				) {
					if (input[i][key].length > 0) {
					// this.pluginLogs.info('[WFM]: list becomes enum')
					properties.push(uiEnum(key, input[i][key]))
					} else {
					// this.pluginLogs.info('[WFM]: list is list')
					properties.push(uiList(key))
					}
				} else {
					// unsupported object
					// this.pluginLogs.info('[WFM]: obj/list not supported')
				}
				})
			} else if (typeof input[i] === 'string') {
				let key = input[i]
				if (['neId', 'neName', 'mgmtIP'].includes(key)) {
				// this.pluginLogs.info('[WFM]: neList: ', key)
				properties.push(uiSuggest(key, 'nspWebUI.neList', key))
				} else if (key === 'port') {
				// this.pluginLogs.info('[WFM]: port')
				properties.push(uiSuggest(key, 'nspWebUI.portList', 'name'))
				} else if (key === 'workflow') {
				// this.pluginLogs.info('[WFM]: workflow')
				properties.push(uiSuggest(key, 'nspWebUI.wfList', 'name'))
				} else if (key === 'intentType') {
				// this.pluginLogs.info('[WFM]: intentType')
				properties.push(uiSuggest(key, 'nspWebUI.intentTypeList', 'name'))
				} else if (key === 'intent') {
				// this.pluginLogs.info('[WFM]: intent')
				properties.push(uiSuggest(key, 'nspWebUI.intentList', 'target'))
				} else if (key === 'nodes') {
				// this.pluginLogs.info('[WFM]: nodes')
				properties.push(
					uiSelectPaged(
					key,
					'nspWebUI.neListPaged',
					'ne-id,ne-name,ip-address,version'
					)
				)
				} else if (key === 'ports') {
				// this.pluginLogs.info('[WFM]: ports')
				properties.push(
					uiSelectPaged(
					key,
					'nspWebUI.portListPaged',
					'name,ne-id,ne-name,description,admin-state,oper-state'
					)
				) // eslint-disable-line max-len
				} else if (key === 'workflows') {
				// this.pluginLogs.info('[WFM]: workflows')
				properties.push(
					uiSelect(key, 'nspWebUI.wfList', 'name,createBy,modifiedBy')
				)
				} else if (key === 'intentTypes') {
				// this.pluginLogs.info('[WFM]: intentTypes')
				properties.push(
					uiSelect(
					key,
					'nspWebUI.intentTypeListWithDetails',
					'name,version,state'
					)
				)
				} else if (key === 'token_auth') {
				// this.pluginLogs.info('[WFM]: ignore token_auth')
				} else {
				// this.pluginLogs.info('[WFM]: string or password')
				properties.push(uiText(input[i], ''))
				}
			} else {
				// this.pluginLogs.info(input[i] + ': ' + typeof input[i])
			}
			} // end-for
		} catch (e) {
			this.pluginLogs.error(JSON.stringify(e, null, 2));
		} // end-try

  		let uijson = { type: 'object', properties: properties }
  		editor.edit(editBuilder => {
			editBuilder.replace(new vscode.Range(doc.lineAt(0).range.start, doc.lineAt(doc.lineCount - 1).range.end), JSON.stringify(uijson, null, 4));
		});
	}

	/* 
	// TEST: testTemplate
	 * Click the run icon on on templates in the editor
	 * Method to test a template in WFM and compare template result with with template in a
	 * compare with clipboard view in VsCode.
	*/
	async testTemplate(): Promise<void> {
		this.pluginLogs.info('[WFM]: testTemplate()');

		const uri = vscode.window.activeTextEditor?.document.uri.toString();
		let filename = uri.split('/').pop().split('.')[0].toString();

		let templateInput = {
			name: filename,
			data: {}
		}

		let input = await vscode.window.showInputBox({
			placeHolder: JSON.stringify(templateInput),
			prompt: 'Enter the input for the template',
			value: "{}"
		});

		templateInput.data = await JSON.parse(input);
		this.pluginLogs.info('templateInput: ' + JSON.stringify(templateInput));

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

		let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/action-execution'
		let response: any = await this._callNSP(url, { 
			method: 'POST', 
			headers: requestHeaders,
			body: JSON.stringify(
				{
					name: "nsp.jinja_template",
					id: "1ba6dfb6-3d67-4a65-ba92-5db89842a503",
					description: "Executing Action nsp.jinja_template from VsCode",
					input: templateInput
				}
			)
		});

		this.pluginLogs.info('response: ' + response);

		if (!response) {
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}
		let data = await response.json();
		let templateResult = data.response.data[0].output.result.template;
		this.pluginLogs.info('templateResult: ' + templateResult);

		const auxVar = await vscode.env.clipboard.readText(); 		// Save the current clipboard content
		try {
			await vscode.env.clipboard.writeText(templateResult); // Copy template execution result to the clipboard
			await vscode.commands.executeCommand('workbench.files.action.compareWithClipboard'); // Execute compare with clipboard
		} catch (error) {
			vscode.window.showErrorMessage('Error during clipboard comparison: ' + error);
		} 
		await vscode.env.clipboard.writeText(auxVar); // Step 4: Restore the original clipboard content
	}

	// have a window that asks to review the expression for changes, for something called data etc...
	// TEST YAQALATOR:
	// 1. highlight a yaql expression in a yaml file use :<% locate_nsp() %> (in "cleanup_WFM.yaml")
	// 2. right-click and select run yaqalator
	// 3. enter context for test use nothing, just {}
	// 4. the result will be in nsp_client logs
	/*
	 * Method to execute a yaql expression in WFM
	*/
	async yaqalator(): Promise<void> {
		this.pluginLogs.info('[WFM]: yaqalator()');

		const editor = vscode.window.activeTextEditor;
		const selection = editor.selection;
		if (selection && !selection.isEmpty) {
			const selectionRange = new vscode.Range(selection.start.line, selection.start.character, selection.end.line, selection.end.character);
			const highlighted = editor.document.getText(selectionRange);
			const regex = /<%[\s\S]*%>/;
			const match = regex.exec(highlighted);
			if (match) {
				this.pluginLogs.info("matched: " + match[0]);
				let yaqlExpression = match[0].replace(/<%|%>/g, '');
				this.pluginLogs.info("yaqlExpression: " + yaqlExpression);

				// make a pop-up window here: allowing use rto modify the expression:
				let newYaqlExpression = await vscode.window.showInputBox({
					placeHolder: "YAQL Expression Selected: " + yaqlExpression,
					prompt: "Modify YAQL Expression if needed",
					value: yaqlExpression
				});

				yaqlExpression = newYaqlExpression ? newYaqlExpression : yaqlExpression;

				// allow the user to enter input for the yaql expression
				let input = await vscode.window.showInputBox({
					placeHolder: "Enter the context for the yaql expression",
					prompt: "Enter the context for the yaql expression",
					value: "{}"
				});

				let jsonInput = await JSON.parse(input);

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

				this.pluginLogs.info('url: ' + 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/action-execution')
				let url = 'https://'+this.nspAddr+':'+this.port+'/wfm/api/v1/action-execution'
				let response: any = await this._callNSP(url, { 
					method: 'POST', 
					headers: requestHeaders,
					body: JSON.stringify(
						{
							name: "nsp.yaql_eval",
							description: "Executing Action nsp.yaql_eval from VsCode",
							input: {context: jsonInput, expression: yaqlExpression}
						}
					)
				});
				let data = await response.json();
				
				this.pluginLogs.info('data: ' + data)
				let result = data.response.data[0].output.result;
				let jsonString = JSON.stringify(result, null, 2); // The `null, 2` arguments are optional, for pretty-printing
				

				const auxVar = await vscode.env.clipboard.readText(); 		// Save the current clipboard content
				try {
					let text = editor.document.getText();
					let newText = text.replace(match[0], jsonString); // copy the new text to the clipboard
					await vscode.env.clipboard.writeText(newText);
					await vscode.commands.executeCommand('workbench.files.action.compareWithClipboard'); // Execute compare with clipboard
				} catch (error) {
					vscode.window.showErrorMessage('Error during clipboard comparison: ' + error);
				} 
				await vscode.env.clipboard.writeText(auxVar); // Step 4: Restore the original clipboard content
			} else {
				vscode.window.showErrorMessage('Select a valid yaql expression surrounded by <% and %>');
			}
		}
	}

	/**
	 * Method to scan a workflow and warn users/recommend best practices according to: 
	 * https://network.developer.nokia.com/learn/24_4/network-programmability-automation-frameworks/workflow-manager-framework/wfm-workflow-development/wfm-best-practices/
	 * @param {vscode.DiagnosticCollection} bestPracticesDiagnostics
	*/
	async runBestPractices(bestPracticesDiagnostics: vscode.DiagnosticCollection): Promise<void> {
		this.pluginLogs.info('[WFM]: runBestPractices()');

		bestPracticesDiagnostics.clear(); // clear any previous diagnostics
		let diagnostics: vscode.Diagnostic[] = [];
		const content = vscode.window.activeTextEditor?.document.getText();

		// BEST PRACTICE: Check for hardcoded IP addresses
		let ipRegex = /(?:[0-9]{1,3}\.){3}[0-9]{1,3}/g;
		let lines = content.split('\n');

		lines.forEach((line, lineNumber) => {
			let match;
			while ((match = ipRegex.exec(line)) !== null) {
				let startChar = match.index;
				let endChar = startChar + match[0].length;
				let diagnostic = new vscode.Diagnostic(
					new vscode.Range(lineNumber, startChar, lineNumber, endChar),
					`WFM - Best Practices: Avoid hard-coding IP addresses into workflows. Use environments and encrypt credentials: ${match[0]}`,
					vscode.DiagnosticSeverity.Warning
				);
				diagnostics.push(diagnostic);
			}
		});

		// BEST PRACTICE: Check for hardcoded Passwords:
		let passwordRegex = /(?:password|passwd|pass|secret|token|auth|authorization|creds|credentials|login):.*$/gi;
		let passwordLines = content.split('\n');

		passwordLines.forEach((line, lineNumber) => {
			let match;
			while ((match = passwordRegex.exec(line)) !== null) {
				let startChar = match.index;
				let endChar = startChar + match[0].length;
				let diagnostic = new vscode.Diagnostic(
					new vscode.Range(lineNumber, startChar, lineNumber, endChar),
					"WFM - Best Practices: Avoid hard-coding passwords into workflows. Use environments and encrypt credentials.",
					vscode.DiagnosticSeverity.Hint
				);
				diagnostics.push(diagnostic);
			}
		});


		// BEST PRACTICE: Check for hardcoded Usernames:
		let usernameRegex = /(?:username|user|login):.*$/gi;
		let usernameLines = content.split('\n');

		usernameLines.forEach((line, lineNumber) => {
			let match;
			while ((match = usernameRegex.exec(line)) !== null) {
				let startChar = match.index;
				let endChar = startChar + match[0].length;
				let diagnostic = new vscode.Diagnostic(
					new vscode.Range(lineNumber, startChar, lineNumber, endChar),
					"WFM - Best Practices: Avoid hard-coding usernames into workflows. Use environments and encrypt credentials.",
					vscode.DiagnosticSeverity.Hint
				);
				diagnostics.push(diagnostic);
			}
		});


		// BEST PRACTICE: Check for no Workflow Documentation:
		let uri = vscode.window.activeTextEditor?.document.uri;
		let docUri = uri?.toString().replace(uri?.path.split('/').pop(), 'README.md');
		let docContent = await this.readFile(vscode.Uri.parse(docUri));
		if (!docContent || docContent.toString().trim() === "") {
			let diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), "WFM - Best Practices: No documentation found for the workflow: Add documentation: What’s the use-case? What are the workflow parameters? Pre-requisites? Supported Releases?", vscode.DiagnosticSeverity.Warning);
			bestPracticesDiagnostics.set(vscode.Uri.parse(docUri), [diagnostic]); // apply to documentation file
		}
		

		// BEST PRACTICE: Check for locate_nsp() in the workflow:
		let locateNspRegex = /<%[\s\S]*locate_nsp\(\)[\s\S]*%>/g;
		let locateNspMatch;
		while ((locateNspMatch = locateNspRegex.exec(content)) !== null) {
			let lineNumber = content.slice(0, locateNspMatch.index).split('\n').length - 1;
			let startChar = locateNspMatch.index - content.lastIndexOf('\n', locateNspMatch.index) - 1;
			let endChar = startChar + locateNspMatch[0].length;
			let diagnostic = new vscode.Diagnostic(
				new vscode.Range(lineNumber, startChar, lineNumber, endChar),
				"WFM - Best Practices: Use Kubernetes service names instead of locate_nsp() which takes too long to evaluate",
				vscode.DiagnosticSeverity.Warning
			);
			diagnostics.push(diagnostic);
		}


		// BEST PRACTICE: Check for output-on-error:
		let outputOnError = content.match(/output-on-error:/g);
		let output = content.match(/output:/g);
		if (output && !outputOnError) {
			let startLine = content.split("output:")[0].split('\n').length - 1;
			let startChar = content.split("output:")[0].split('\n').pop().length;
			let endLine = startLine;
			let endChar = startChar + "output:".length;
			let diagnostic = new vscode.Diagnostic(new vscode.Range(startLine, startChar, endLine, endChar), "WFM - Best Practices: Add support for output and output-on-error to simplify result processing", vscode.DiagnosticSeverity.Warning);
			diagnostics.push(diagnostic);
		}

		// BEST PRACTICE: Do not use special characters in the workflow or artifact name. These will cause issues when executed using the API
		let filename = vscode.window.activeTextEditor?.document.fileName.split('/').pop().split('.')[0].toString();
		let workflowName = filename + ':';
		
		// no special chars is anything other than numbers and letters or :
		let specialCharsPattern = /[^a-zA-Z0-9:]/;
		if (specialCharsPattern.test(workflowName)) {
			let startLine = content.split(workflowName)[0].split('\n').length - 1;
			let startChar = content.split(workflowName)[0].split('\n').pop().length;
			let endLine = startLine;
			let endChar = startChar + workflowName.length;
			let diagnostic = new vscode.Diagnostic(new vscode.Range(startLine, startChar, endLine, endChar), "WFM - Best Practices: Do not use special characters in the workflow or artifact name. These will cause issues when executed using the API", vscode.DiagnosticSeverity.Warning);
			diagnostics.push(diagnostic);
		}


		// BEST PRACTICE: Check for REST queries without filters
		let restQueries = content.match(/https?:\/\/[^\s]+/g);
		if (restQueries) {
			restQueries.forEach(query => {
				if (!query.includes('?')) { // If no query parameters found
					let startLine = content.split(query)[0].split('\n').length - 1;
					let startChar = content.split(query)[0].split('\n').pop().length;
					let endLine = startLine;
					let endChar = startChar + query.length;
					let diagnostic = new vscode.Diagnostic(new vscode.Range(startLine, startChar, endLine, endChar), "WFM - Best Practices: REST query found without filters. Apply server-side filtering to reduce data transfer.", vscode.DiagnosticSeverity.Information);
					diagnostics.push(diagnostic);
				}
			});
		}

		// BEST PRACTICE: Use nsp.https instead of std.http
		let httpActions = content.match(/std\.http/g);
		if (httpActions) {
			let actionRegex = /std\.http/g;
			let match;
			while ((match = actionRegex.exec(content)) !== null) {
				let lineNumber = content.slice(0, match.index).split('\n').length - 1;
				let startChar = match.index - content.lastIndexOf('\n', match.index) - 1;
				let endChar = startChar + match[0].length;
				let diagnostic = new vscode.Diagnostic(
					new vscode.Range(lineNumber, startChar, lineNumber, endChar),
					"WFM - Best Practices: Use nsp.https instead of std.http",
					vscode.DiagnosticSeverity.Warning
				);
				diagnostics.push(diagnostic);
			}
		}


		const yaml = require('yaml');
		const yamlDoc = yaml.parse(content);
		let tasks: any = yamlDoc[filename]['tasks'];
		let tasksList = Object.keys(tasks);
		
		for (let i = 0; i < tasksList.length; i++) {
			let task = tasks[tasksList[i]];
			let taskName = tasksList[i];

			// BEST PRACTICE: Do not use join with with-items or concurrency in the same task
			if (task['join'] != undefined && (task['with-items'] != undefined || task['concurrency'] != undefined)) {
				let startLine = content.split("tasks"+':')[0].split('\n').length - 1;
				let startChar = content.split("tasks"+':')[0].split('\n').pop().length;
				let endLine = startLine;
				let endChar = startChar + "tasks".length;
				let diagnostic = new vscode.Diagnostic(new vscode.Range(startLine, startChar, endLine, endChar), "WFM - Best Practices: Do not use join statements in conjunction with with-items & concurrency in the same task. Instead separate the join and the with-items/concurrency into two tasks, create a std.noop task with the join statement first and then have the with-items task run next on-complete of the std.noop task", vscode.DiagnosticSeverity.Warning);
				diagnostics.push(diagnostic);
			}
			
			// BEST PRACTICE: Do not use std.fail to fail tasks and proceed further in the flow. std.fail fails the entire workflow. Instead use nsp.assert to pass/fail the tasks validation
			if (task['action'] === 'std.fail') {
				let startLine = content.split("tasks"+':')[0].split('\n').length - 1;
				let startChar = content.split("tasks"+':')[0].split('\n').pop().length;
				let endLine = startLine;
				let endChar = startChar + "tasks".length;
				let diagnostic = new vscode.Diagnostic(new vscode.Range(startLine, startChar, endLine, endChar), "WFM - Best Practices: Do not use std.fail to fail tasks and proceed further in the flow. std.fail fails the entire workflow. Instead use nsp.assert to pass/fail the tasks validation", vscode.DiagnosticSeverity.Warning);
				diagnostics.push(diagnostic);
			}

			// BEST PRACTICE: When a task is reused in multiple branches specifically a task that has a further flow, use a "join: 0" 
			let taskNameCount = (content.match(new RegExp(taskName, "g")) || []).length;
			if (taskNameCount > 2)	{	// if taskname comes up more than once in the rest of the content, because first is the taks def and then once, so > 2
				if (task['join'] === 0) { // check the yaml to make sure join: 0 is aready not there
					continue;
				}
				let startLine = content.split(taskName + ":")[0].split('\n').length - 1;
				let startChar = content.split(taskName + ":")[0].split('\n').pop().length;
				let endLine = startLine;
				let endChar = startChar + taskName.length;
				let diagnostic = new vscode.Diagnostic(new vscode.Range(startLine, startChar, endLine, endChar), "WFM - Best Practices: When a task is reused in multiple branches specifically a task that has a further flow, use a 'join: 0' on such tasks to make the previewer flow diagram more compact. This does not impact the execution flow", vscode.DiagnosticSeverity.Information);
				diagnostics.push(diagnostic);
			}
		}

		// BEST PRACTICE: Avoid using vars that take too long to evaluate. Long evaluating vars will 
		// timeout after 60s. Remove them from the definition and define them as part of some task.
		const varsRegex = /vars:\s*[\s\S]*$/gm;
		lines.forEach((line, lineNumber) => {
			let match;
			while ((match = varsRegex.exec(line)) !== null) {
				let startChar = match.index;
				let endChar = startChar + match[0].length;
				let diagnostic = new vscode.Diagnostic(
					new vscode.Range(lineNumber, startChar, lineNumber, endChar),
					"WFM - Best Practices: Avoid using vars that take too long to evaluate. Long evaluating vars will timeout after 60s. Remove them from the definition and define them as part of some task.",
					vscode.DiagnosticSeverity.Hint
				);
				diagnostics.push(diagnostic);
			}
		});


		if (vscode.window.activeTextEditor) { // Set the diagnostics in the collection
			bestPracticesDiagnostics.set(vscode.window.activeTextEditor.document.uri, diagnostics);
		}
	}

	// FIND AN ALTERNATE WAY OTHER THAN ICON: If thers another option, maybe rihgt clicking a problem to remove them
	// right click on a file, and remove problems from that file, using a conditional, if it has problems
	/**
	 * Method to delete vscode problems from a diagnostic collections, for a workflow
	 * @param {vscode.DiagnosticCollection} bestPracticesDiagnostics
	*/
	async clearProblems(bestPracticesDiagnostics: vscode.DiagnosticCollection, uri: vscode.Uri): Promise<void> {
		this.pluginLogs.info("Removing Diagnostics Collection. URI: " + uri.toString());
		
		let path = uri.path
		const fileName = path.split('/').pop() || '';
		let yamlDefUri = vscode.Uri.parse(uri.toString() + "/" + fileName + ".yaml")
		let docUri = vscode.Uri.parse(uri.toString() + "/README.md")
		this.pluginLogs.info(yamlDefUri.toString())
		this.pluginLogs.info(docUri.toString())
		bestPracticesDiagnostics.delete(yamlDefUri)
		bestPracticesDiagnostics.delete(docUri)
	}	
	

	// ----------------- vscode.FileSystemProvider implementation ----------------
	/**
	 * vsCode.FileSystemProvider method to read directory entries.
	 * WorkflowManagerProvider uses this as main method to pull data from WFM
	 * while storing it in memory (as cache).
	 * @param {vscode.Uri} uri URI of the folder to retrieve from NSP
	*/	
	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		this.pluginLogs.info("[WFM]: readDirectory("+uri.toString()+")");
		let url = undefined;

		if (!this.nspVersion) {
			this._getNSPversion(); // get the version of the NSP
		}

		if (uri.toString() === "wfm:/") { // if root
			return [['actions', vscode.FileType.Directory],['workflows', vscode.FileType.Directory], ['templates', vscode.FileType.Directory]]; // return the actions and workflows and templates.
		} else if (uri.toString() === "wfm:/workflows") { // if were in workflows directory, set the url to get the workflows
			url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/workflow?fields=id,name,created_at,updated_at,tags";
		} else if (uri.toString() === "wfm:/actions") { // if were in actions directory, set the url to get the actions
			url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/action?fields=id,name,created_at,updated_at&is_system=false"; 
		} else if (uri.toString() === "wfm:/templates") { // if were in templates directory, set the url to get the templates
			url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/jinja-template?fields=id,name,created_at,updated_at";	
		} else if (uri.toString().startsWith("wfm:/workflows/")) { // if were in tehe workflow folders dir
			url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/workflow?fields=id,name,created_at,updated_at,tags";
		} else {
			throw vscode.FileSystemError.FileNotADirectory('Unknown Resource!');
		}
		
		let response: any = await this._callNSP(url, {method: 'GET'});
		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		this.pluginLogs.info("[WFM]: GET", url, response.status);
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable('Cannot get workflow list');
		}
		
		const json = await response.json();
		if (uri.toString() === "wfm:/workflows") {
			this.workflow_folders = (json?.response.data ?? []).reduce((workflow_folders: any, entry: any) =>
				(workflow_folders[entry.name] = new FileStat(entry.id, 'directory', Date.parse(entry.created_at), Date.parse(entry.updated_at), 0, entry.details.signature === "SIGNED"), workflow_folders), {}
			);	
			this.workflows = (json?.response.data ?? []).reduce((workflows: any, entry: any) =>
				(workflows[entry.name + '.yaml'] = new FileStat(entry.id, 'file', Date.parse(entry.created_at), Date.parse(entry.updated_at), 0, entry.details.signature === "SIGNED"), workflows), {}
			);
			this.workflow_documentations = (json?.response.data ?? []).reduce((workflow_documentations: any, entry: any) =>
				(workflow_documentations[entry.name + '.md'] = new FileStat(entry.id, 'file', Date.parse(entry.created_at), Date.parse(entry.updated_at), 0, entry.details.signature === "SIGNED"), workflow_documentations), {}
			);
			this.workflow_views = (json?.response.data ?? []).reduce((workflow_views: any, entry: any) =>
				(workflow_views[entry.name + '.json'] = new FileStat(entry.id, 'file', Date.parse(entry.created_at), Date.parse(entry.updated_at), 0, entry.details.signature === "SIGNED"), workflow_views), {}
			);
		} else if (uri.toString() === "wfm:/actions") {
			this.actions = (json?.response.data ?? []).reduce((actions: any, entry: any) =>
				(actions[entry.name + '.action'] = new FileStat(entry.id, 'file', Date.parse(entry.created_at), Date.parse(entry.updated_at), 0, entry.actionDetail.signature === "SIGNED"), actions), {}
			);
		} else if (uri.toString() === "wfm:/templates") { 
			this.templates = (json?.response.data ?? []).reduce((templates: any, entry: any) =>
				(templates[entry.name + '.jinja'] = new FileStat(entry.id, 'file', Date.parse(entry.created_at), Date.parse(entry.updated_at), 0, entry.signature === "SIGNED"), templates), {}
			);
		} else if (uri.toString().startsWith("wfm:/workflows/")) { // If we are opening up a workflow folder inside of the workflows folder
			this.workflows = (json?.response.data ?? []).reduce((workflows: any, entry: any) =>
				(workflows[entry.name + '.yaml'] = new FileStat(entry.id, 'file', Date.parse(entry.created_at), Date.parse(entry.updated_at), 0, entry.details.signature === "SIGNED"), workflows), {}
			);
			this.workflow_documentations = (json?.response.data ?? []).reduce((workflow_documentations: any, entry: any) =>
				(workflow_documentations[entry.name + '.md'] = new FileStat(entry.id, 'file', Date.parse(entry.created_at), Date.parse(entry.updated_at), 0, entry.details.signature === "SIGNED"), workflow_documentations), {}
			);
			this.workflow_views = (json?.response.data ?? []).reduce((workflow_views: any, entry: any) => 
				(workflow_views[entry.name + '.json'] = new FileStat(entry.id, 'file', Date.parse(entry.created_at), Date.parse(entry.updated_at), 0, entry.details.signature === "SIGNED"), workflow_views), {}
			);
			this.workflow_folders = (json?.response.data ?? []).reduce((workflow_folders: any, entry: any) =>
				(workflow_folders[entry.name] = new FileStat(entry.id, 'directory', Date.parse(entry.created_at), Date.parse(entry.updated_at), 0, entry.details.signature === "SIGNED"), workflow_folders), {}
			);
		}

		let filteredList = json?.response.data; // get the list of workflows or actions or templates
		if (uri.toString() === "wfm:/workflows" ) {
			function checkLabels(obj,ignoreLabels){
				var filteredArray = ignoreLabels.tags.filter(value => obj.includes(value));
				if (filteredArray.length==0){
					return ignoreLabels;
				}
			}
			filteredList = json?.response.data.filter(checkLabels.bind(this,this.fileIgnore));
			return (filteredList ?? []).map(entry  => [entry.name, vscode.FileType.Directory] as [string, vscode.FileType.Directory]); // returns the workflow folders.
		} else if (uri.toString() === "wfm:/actions") {
			var result: [string, vscode.FileType][] = (filteredList ?? []).map(entry => [entry.name + '.action', vscode.FileType.File] as [string, vscode.FileType]);			
		} else if (uri.toString() === "wfm:/templates") {
			this.pluginLogs.info('[WFM]: URI: wfm:/templates')
			var result: [string, vscode.FileType][] = (filteredList ?? []).map(entry => [entry.name + '.jinja', vscode.FileType.File] as [string, vscode.FileType]);			
		} else if (uri.toString().startsWith("wfm:/workflows/")) { // returns a workflow folder
			let curr_workflow_name = uri.toString().substring(15);
			var result: [string, vscode.FileType][] = [[curr_workflow_name + '.yaml', vscode.FileType.File], [curr_workflow_name + '.json', vscode.FileType.File], ['README.md', vscode.FileType.File]];
		}
		return result;
	}

	/**
	 * vsCode.FileSystemProvider method to get details/metadata about files and folders.
	 * Returns type (file/directory), timestamps (create/modify), file size,
	 * and access permissions (read/write).
	 * @param {vscode.Uri} uri URI of the folder to retrieve from NSP
	 */	
	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		this.pluginLogs.info('[WFM]: stat('+uri+')');

		const path = uri.toString();		

		// this needs to be the pattern or we have an extra path
		// the pattern will have the following format: wfm:/workflows/<workflow_name>/<workflow_file> or wfm:/actions/<action_name>.action
		const pattern = /^wfm:\/(workflows|actions|templates)\/.*/;
		
		if (path.endsWith('.')) {
			throw vscode.FileSystemError.FileNotFound('No Permissions!');
		}
		
		if ((path ==='wfm:/') || (path==='wfm:/workflows') || (path==='wfm:/actions') || (path==='wfm:/templates')) {
			this.pluginLogs.debug("stat("+path+")");
			return {
				type: vscode.FileType.Directory,
				ctime: 0,
				mtime: Date.now(),
				size: 0,
				permissions: vscode.FilePermission.Readonly
			};
		}

		if (pattern.test(path)) {
			this.pluginLogs.debug("stat("+path+")");
			let path_length = path.split('/').length;
			if (path.startsWith('wfm:/workflows/') && path_length > 3 && !(path.endsWith('.yaml') || path.endsWith('.json') || path.endsWith('.md'))) {
				this.pluginLogs.error("No Permission to add a folder/file within a workflow folder!");
				throw vscode.FileSystemError.FileNotFound('No Permission to add a folder/file within a workflow folder!');
			}
			
			else if (path.startsWith('wfm:/workflows/') && !(path.endsWith('.yaml') || path.endsWith('.json') || path.endsWith('.md'))) { // if the uri is a workflow folder
				if (Object.keys(this.workflow_folders).length === 0) { // if the workflows cache is empty:
					await this.readDirectory(vscode.Uri.parse('wfm:/workflows'));
				}
				const key = path.split('/')[2];
				if (key in this.workflow_folders) {
					return this.workflow_folders[key];
				}
				this.pluginLogs.error("Unkown Workflow!");
				throw vscode.FileSystemError.FileNotFound('Unknown workflow!');
			} else if (path.startsWith('wfm:/workflows/') && path.endsWith('.yaml')) {
				if (Object.keys(this.workflows).length === 0) { // if the workflows are empty
					await this.readDirectory(vscode.Uri.parse('wfm:/workflows'));
				}
				const key = path.split('/')[3];
				if (key in this.workflows) {
					return this.workflows[key];
				}
				this.pluginLogs.error("Unkown Workflow!");
				throw vscode.FileSystemError.FileNotFound('Unknown workflow!');
			} else if (path.startsWith('wfm:/workflows/') && path.endsWith('.md')) {
				if (Object.keys(this.workflows).length === 0) {
					await this.readDirectory(vscode.Uri.parse('wfm:/workflows'));
				}
				if (!(path.split('/')[3] === 'README.md')) { // if user attempts to rename the workflow doc to other than README.md
					return; // returning here will prompt the error checking in rename:
				}
				const key = path.split('/')[2] + '.md';
				if (key in this.workflow_documentations) {
					return this.workflow_documentations[key];
				}
				this.pluginLogs.error("Unkown Workflow!");
				throw vscode.FileSystemError.FileNotFound('Unknown workflow!');
			} else if (path.startsWith('wfm:/workflows/') && path.endsWith('.json')) {
				if (Object.keys(this.workflows).length === 0) {
					await this.readDirectory(vscode.Uri.parse('wfm:/workflows'));
				}
				const key = path.split('/')[3];
				if (key in this.workflow_views) {
					return this.workflow_views[key];
				}
				this.pluginLogs.error("Unkown Workflow!");
				throw vscode.FileSystemError.FileNotFound('Unknown workflow!');
			}
			
			if (path.startsWith('wfm:/actions/')) {
				if (Object.keys(this.actions).length === 0) {
					await this.readDirectory(vscode.Uri.parse('wfm:/actions'));
				}
				const key = path.substring(13); // get the key of the action
				if (key in this.actions) {
					return this.actions[key];
				}
				this.pluginLogs.error("Unkown Action!");
				throw vscode.FileSystemError.FileNotFound('Unknown action!');
			} else if(path.startsWith('wfm:/templates/')) {
				if (Object.keys(this.templates).length === 0) {
					await this.readDirectory(vscode.Uri.parse('wfm:/templates'));
				}
				const key = path.substring(15); // get the key of the action
				if (key in this.templates) {
					return this.templates[key];
				}
				this.pluginLogs.error("Unkown Template!");
				throw vscode.FileSystemError.FileNotFound('Unknown template!');
			}
		} else {
			throw vscode.FileSystemError.FileNotFound('Unknown resource!');
		}
	}

	/**
	 * vsCode.FileSystemProvider method to read file content into an editor window.
	 * WorkflowManagerProvider will not reach out to NSP to read files, 
	 * instead is uses the copy stored in memory.
	 * @param {vscode.Uri} uri URI of the folder to retrieve from NSP
	*/
	async readFile(uri: vscode.Uri): Promise<Uint8Array> { // VsCode readFile function: returns the file content of the file
		const path = uri.toString();
		let url = undefined;
		if (uri.toString().startsWith("wfm:/actions/")) {
			let id = uri.toString().substring(13).replace('.action', '');
			url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/action/"+id+"/definition";
		} else if (uri.toString().startsWith("wfm:/templates/")) {
			let id = uri.toString().substring(15).replace('.jinja', '');
			url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/jinja-template/"+id+"/definition";
		} else if (uri.toString().startsWith("wfm:/workflows/")) {
			if (uri.toString().endsWith('.json')) { // if its a view
				let id = uri.toString().substring(15).replace('.json', '').split('/').pop();
				url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/workflow/"+id+"/ui"
			} else if (uri.toString().endsWith('.yaml')) { // if its yaml def or readme
				let id = uri.toString().substring(15).replace('.yaml', '').split('/').pop();
				url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/workflow/"+id+"/definition";
			} else {
				let id = uri.toString().split("/")[2]
				url = "https://"+this.nspAddr+":"+this.port+"/wfm/api/v1/workflow/"+id;
			}
		} else {
			throw vscode.FileSystemError.FileNotADirectory('Unknown Resources!');
		}

		this.pluginLogs.debug("readFile("+path+")");

		await this._getAuthToken(); // get auth-token
		const token = await this.authToken;
		if (!token) {
            throw vscode.FileSystemError.Unavailable('NSP is not reachable');
        }

		let response: any = await this._callNSP(url, { // get either workflow/action/template definition
			method: 'GET'
		});

		if (!response){
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		}

		if (!response.ok) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}

		let text = await response.text();
		if (uri.toString().startsWith("wfm:/templates/")) { // if we are in the templates directory
			this.pluginLogs.info('[WFM]: URI: wfm:/templates');
			const yaml = require('yaml');
			const doc = yaml.parse(text);
			return Buffer.from(doc.template); // return only the template buffer
		}
		if (uri.toString().startsWith("wfm:/workflows/") && uri.toString().endsWith('.md')) { // if we are in the workflow_documentation directory
			const yaml = require('yaml');
			const doc = yaml.parse(text);
			let readme = doc.response.data.details.readme;
			if (readme === null) {
				readme = ''
			}
			return Buffer.from(readme); // return only the readme buffer
		}
		if (uri.toString().startsWith("wfm:/workflows/") && uri.toString().endsWith('.json')) {
			let json_text = JSON.parse(text);
			let data = '';
			if (json_text.response.data.yang !== undefined && json_text.response.data.json !== undefined) { // if yang and json attributes are generated when rereading the file from NSP we dont account for them
				data = json_text.response.data.json;
			} else {
				data = json_text.response.data;
			}
			let formatted = JSON.stringify(data, null, 4);
			return Buffer.from(formatted); // return the formatted json buffer
		}
		return Buffer.from(text); // otherwise return the text buffer
	}

	/**
	 * vsCode.FileSystemProvider method to create or update files in  NSP virtual filesystem
	 * for Intent Manager. Support intent-types, intents and views.
	 * @param {vscode.Uri} uri URI of the file to create/update
	 * @param {Uint8Array} content content of the file
	 * @param {Object} options allow/enforce to create/overwrite
	 */
	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Promise<void> {
		this.pluginLogs.info("[WFM]: writeFile("+uri+")");
		
		if (uri.toString().startsWith('wfm:/workflows/')) {
			if (uri.toString().endsWith('.json')) { // if its a view
				const key = uri.toString().substring(15).split('/').pop();
				await this._writeWorkflowView(key, content.toString());
			} else if (uri.toString().endsWith('.yaml')) { // if its yaml def or readme
				const key = uri.toString().substring(15).split('/').pop();
				await this._writeWorkflow(key, content.toString());
			} else if (uri.toString().endsWith('.md')) { // if its a readme
				await this._writeWorkflowDocumentation(uri, content.toString());
			}
		} else if (uri.toString().startsWith('wfm:/actions/')) {
			const key = uri.toString().substring(13);
			await this._writeAction(key, content.toString());
		} else if (uri.toString().startsWith('wfm:/templates/')) {
			const key = uri.toString().substring(15);
			await this._writeTemplate(key, content.toString());
		} else {
			throw vscode.FileSystemError.FileNotFound('Unknown resource-type!');
		}
	}

	/**
	 * vsCode.FileSystemProvider method to rename folders and files.
	 * @param {vscode.Uri} oldUri URI of the file or folder to rename
	 * @param {vscode.Uri} newUri new file/folder name to be used
	 * @param {{overwrite: boolean}} options additional options
	*/	
	async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		this.pluginLogs.info("[WFM]: rename("+oldUri+", "+newUri+")");

		if (oldUri.toString().endsWith('.') || newUri.toString().endsWith('.')) {
			this.pluginLogs.error('No Permissions!')
			throw vscode.FileSystemError.NoPermissions('No Permissions!');
		}
		if (oldUri.toString().startsWith('wfm:/workflows/') && newUri.toString().includes('.md')) {
			this.pluginLogs.error('No Permissions!')
			throw vscode.FileSystemError.NoPermissions('No Permissions!');
		}
		if (oldUri.toString().startsWith('wfm:/workflows/') && newUri.toString().endsWith('.json') || newUri.toString().endsWith('.yaml')) {
			this.pluginLogs.error('No Permissions!')
			throw vscode.FileSystemError.NoPermissions('Must rename the workflow folder!');
		}
		if (oldUri.toString().startsWith('wfm:/workflows/') && newUri.toString().startsWith('wfm:/workflows/')) {
			const oldName : string = oldUri.toString().substring(15);
			const newName : string = newUri.toString().substring(15);
			if (!newName.endsWith('.yaml')) {
				await this._renameWorkflow(oldName + '.yaml', newName + '.yaml');
			} else {
				await this._renameWorkflow(oldName, newName);
			}	
		} else if (oldUri.toString().startsWith('wfm:/actions/') && newUri.toString().startsWith('wfm:/actions/')) {
			const oldName : string = oldUri.toString().substring(13);
			const newName : string = newUri.toString().substring(13);
			if (!newName.endsWith('.action')) { // if the newName does not end with .yaml throw a vscode error and return
				throw vscode.FileSystemError.NoPermissions('Action filename must end with .action');
			} else {
				await this._renameAction(oldName, newName);
			}
		} else if (oldUri.toString().startsWith('wfm:/templates/') && newUri.toString().startsWith('wfm:/templates/')) {
			const oldName : string = oldUri.toString().substring(15);
			const newName : string = newUri.toString().substring(15);
			if (!newName.endsWith('.jinja')) { // if the newName does not end with .yaml throw a vscode error and return
				throw vscode.FileSystemError.NoPermissions('Template filename must end with .jinja');
			} else {
				await this._renameTemplate(oldName, newName);
			}
		} else {
			throw vscode.FileSystemError.NoPermissions('Unsupported operation!');
		}
	}


	/**
	 * vsCode.FileSystemProvider method to delete files in  NSP virtual filesystem
	 * for Workflow Manager. Support intent-types, intents and views.
	 * @param {vscode.Uri} uri URI of the file to delete
	*/	
	async delete(uri: vscode.Uri): Promise<void> {
		this.pluginLogs.info("[WFM]: delete("+uri+")");

		const path = uri.toString();
		if (path === "wfm:/workflows") { // no permissions to delete a directory
			this.pluginLogs.error("Cannot Delete Directory");
			throw vscode.FileSystemError.NoPermissions('Permission denied!');
		} else if (path === "wfm:/actions") {
			this.pluginLogs.error("Cannot Delete Directory");
			throw vscode.FileSystemError.NoPermissions('Permission denied!');
		} else if (path === "wfm/templates") {
			this.pluginLogs.error("Cannot Delete Directory");
			throw vscode.FileSystemError.NoPermissions('Permission denied!');
		} else if (path.startsWith("wfm:/workflows/") && !(path.endsWith('.json') || path.endsWith('.yaml') || path.endsWith('.md'))) {
			let key = path.substring(15);
			await this._deleteWorkflow(key);
		} else if (path.startsWith("wfm:/workflows/") && (path.endsWith('.json') || path.endsWith('.yaml') || path.endsWith('.md'))) {
			let folder_name = path.split("/").pop().split(".")[0];
			this.pluginLogs.error("Permission denied! Must delete the '+folder_name+' workflow folder!");
			throw vscode.FileSystemError.NoPermissions('Permission denied! Must delete the '+folder_name+' workflow folder!');
		} else if (path.startsWith("wfm:/actions/")) {
			let key = path.substring(13);
			await this._deleteAction(key);
		} else if (path.startsWith("wfm:/templates/")) {
			let key = path.substring(15);
			await this._deleteTemplate(key);
		} else {
			this.pluginLogs.error("No Permissions to delete (' + uri +  ')!");
			throw vscode.FileSystemError.FileNotFound('No Permissions to delete (' + uri +  ')!');
		}
	}

	/**
	 * vsCode.FileSystemProvider method to create folders.
	 * @param {vscode.Uri} uri URI of the folder to be created
	*/	
	createDirectory(uri: vscode.Uri): void {
		this.pluginLogs.info("[WFM]: createDirectory("+uri+")");
		if (uri.toString().endsWith('.')) {
			throw vscode.FileSystemError.NoPermissions('No Permissions!');
		}
		if (uri.toString().startsWith('wfm:/workflows/') && uri.toString().split('/').length == 3 && !(uri.toString().endsWith('.json') || uri.toString().endsWith('.yaml') || uri.toString().endsWith('.md'))) {
			this._writeWorkflow(uri.toString().substring(15) + '.yaml', '');
		} else if (uri.toString().startsWith('wfm:/workflows/') && uri.toString().split('/').length >= 4 && !uri.toString().includes('.')) {
			throw vscode.FileSystemError.NoPermissions('No Permissions to add a folder within a workflow folder!');
		} else {
			throw vscode.FileSystemError.NoPermissions('Unknown Resource!');
		}
	}

	/**
	 * Method to save files to local filesystem
	 * @param {string} name - name of file to be saved
	 * @param {string} data - data within file being saved
	*/
	saveBackupLocally(name: string, data: string): void {
		if (this.localsave===true) {
			let fs = require("fs");
			this.pluginLogs.info("[WFM]: Saving a backup locally in the temp folder "+this.localpath);
			let extURI = vscode.Uri.parse("file://"+this.localpath);
			let filepath = vscode.Uri.joinPath(extURI, name).toString().replace("file://","");
			fs.writeFile(filepath, data, (err) => {
				if(err) {
					this.pluginLogs.error(err); 
				}
				this.pluginLogs.info("[WFM]: Successfully saved in local repo."); 
			});
		}
	}

	// --- SECTION: vscode.FileDecorationProvider implementation ------------
	/**
	 * vscode.FileDecorationProvider method to get decorations for files and folders.
	 * Used by WorkflowManagerProvider to indicate signature, alignment state, ...
	 * @param {vscode.Uri} uri URI of the folder to retrieve from NSP
	 */	
	public provideFileDecoration( uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {

		const path = uri.toString();
		if (path === 'wfm:/') {
			this.pluginLogs.debug("provideFileDecoration(wfm:/)");
			if (this.nspVersion) {
				DECORATION_CONNECTED.tooltip = "Connected to "+this.username+"@"+this.nspAddr+" (Release: "+this.nspVersion+")";
				DECORATION_DISCONNECTED.tooltip = "Not connected!"; // revert to original text
				return DECORATION_CONNECTED;
			} else {
				return DECORATION_DISCONNECTED;
			}
		}
		
		if (path.startsWith('wfm:/workflows/')) {
			this.pluginLogs.debug("provideFileDecoration(" + path + ")");
			const key = uri.toString().substring(15);
			if (this.workflows[key+'.yaml'].signed) return DECORATION_SIGNED;
			return DECORATION_UNSIGNED;
		} else if (uri.toString().startsWith('wfm:/actions/')) {
			this.pluginLogs.debug("provideFileDecoration(" + path + ")");
			const key = uri.toString().substring(13);
			if (this.actions[key].signed) return DECORATION_SIGNED;
			return DECORATION_UNSIGNED;
		}
	}	

	/**
	 * Update WorkflowManagerProvider after configuration changes 
	*/	
	public async updateSettings() {
		this.pluginLogs.info("[WFM]: Updating WorkflowManagerProvider after configuration change");

		const config = vscode.workspace.getConfiguration('workflowManager');
		this.timeout = config.get('timeout') ?? 90; // default 3min
		this.fileIgnore = config.get('ignoreTags') ?? [];
		this.localsave = config.get("localStorage.enable") ?? false;
		this.localpath = config.get("localStorage.folder") ?? "";

		const nsp:string = config.get('NSPIP') ?? 'localhost';
		const user:string = config.get("user") ?? "admin";
		const port:string = config.get("port") ?? "443";
		const pass = await this.secretStorage.get("nsp_wfm_password");

		if (nsp !== this.nspAddr || user !== this.username || port !== this.port || pass !== this.password) {
			this.pluginLogs.warn("Disconnecting from NSP", this.nspAddr);
			this._revokeAuthToken();
			this.nspAddr = nsp;
			this.username = user;
			this.port = port;
			this.nspVersion = undefined;
			this.osdVersion = undefined;
			
			DECORATION_CONNECTED.tooltip = "Connecting..."; // revert to original text
			DECORATION_DISCONNECTED.tooltip = "Not connected!"; // revert to original text
			this._eventEmiter.fire(vscode.Uri.parse('wfm:/'));
			await this.readDirectory(vscode.Uri.parse('wfm:/'));
		}
		this.workflow_folders = {};
		this.workflows = {};
		this.workflow_documentations = {};
		this.workflow_views = {};
		this.actions = {};
		this.templates = {};
		vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
	}


	// --- manage file events
	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event; // event emitter for file changes

	watch(_resource: vscode.Uri): vscode.Disposable { // watch for file changes
		return new vscode.Disposable(() => { }); // ignore, fires for all changes...
	}	
}

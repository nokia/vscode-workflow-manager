/**
 * Copyright 2023 Nokia
 * Licensed under the BSD 3-Clause License.
 * SPDX-License-Identifier: BSD-3-Clause
*/

import * as vscode from 'vscode';

export class CodelensProvider implements vscode.CodeLensProvider {

	ip: string;
	constructor (ip: string) {
		this.ip = ip;
	}

	async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
		let topOfDocument = new vscode.Range(0, 0, 0, 0);

		let header = {
			title: 'Workflow Manager at '+this.ip+' by NOKIA',
			command: 'nokia-wfm.openInBrowser'
		};
	
		let codeLens = new vscode.CodeLens(topOfDocument, header);
		return [codeLens];
	}
}
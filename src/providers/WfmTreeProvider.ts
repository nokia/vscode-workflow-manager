import * as vscode from 'vscode';
import { WorkflowManagerProvider } from './WorkflowManagerProvider';

export class WfmTreeItem extends vscode.TreeItem {
	readonly uri: vscode.Uri;
	readonly type: vscode.FileType;

	constructor(
		label: string,
		uri: vscode.Uri,
		type: vscode.FileType,
		collapsibleState: vscode.TreeItemCollapsibleState
	) {
		super(label, collapsibleState);
		this.uri = uri;
		this.type = type;
		this.resourceUri = uri;
		if (type === vscode.FileType.File) {
			this.command = {
				command: 'vscode.open',
				title: 'Open',
				arguments: [uri]
			};
		}
	}
}

class WfmWorkflowsFolderItem extends WfmTreeItem {
	constructor(uri: vscode.Uri) {
		super('workflows', uri, vscode.FileType.Directory, vscode.TreeItemCollapsibleState.Collapsed);
		this.contextValue = 'wfmWorkflowsFolder';
	}
}

class WfmActionsFolderItem extends WfmTreeItem {
	constructor(uri: vscode.Uri) {
		super('actions', uri, vscode.FileType.Directory, vscode.TreeItemCollapsibleState.Collapsed);
		this.contextValue = 'wfmActionsFolder';
	}
}

class WfmTemplatesFolderItem extends WfmTreeItem {
	constructor(uri: vscode.Uri) {
		super('templates', uri, vscode.FileType.Directory, vscode.TreeItemCollapsibleState.Collapsed);
		this.contextValue = 'wfmTemplatesFolder';
	}
}

class WfmWorkflowFolderItem extends WfmTreeItem {
	constructor(label: string, uri: vscode.Uri) {
		super(label, uri, vscode.FileType.Directory, vscode.TreeItemCollapsibleState.Collapsed);
		this.contextValue = 'wfmWorkflowFolder';
	}
}

class WfmActionItem extends WfmTreeItem {
	constructor(label: string, uri: vscode.Uri) {
		super(label, uri, vscode.FileType.File, vscode.TreeItemCollapsibleState.None);
		this.contextValue = 'wfmActionItem';
	}
}

class WfmTemplateItem extends WfmTreeItem {
	constructor(label: string, uri: vscode.Uri) {
		super(label, uri, vscode.FileType.File, vscode.TreeItemCollapsibleState.None);
		this.contextValue = 'wfmTemplateItem';
	}
}

export class WfmTreeProvider implements vscode.TreeDataProvider<WfmTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<WfmTreeItem | undefined | void> =
		new vscode.EventEmitter<WfmTreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<WfmTreeItem | undefined | void> =
		this._onDidChangeTreeData.event;

	constructor(private readonly wfmProvider: WorkflowManagerProvider) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: WfmTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: WfmTreeItem): Promise<WfmTreeItem[]> {
		const parentUri = element?.uri ?? vscode.Uri.parse('wfm:/');
		try {
			const parentUriString = parentUri.toString();
			if (element?.type === vscode.FileType.Directory && parentUriString.startsWith('wfm:/workflows/')) {
				const workflowName = element.label;
				const workflowFiles = [
					`${workflowName}.yaml`,
					`${workflowName}.json`,
					'README.md'
				];
				return workflowFiles.map((name) =>
					new WfmTreeItem(
						name,
						vscode.Uri.joinPath(parentUri, name),
						vscode.FileType.File,
						vscode.TreeItemCollapsibleState.None
					)
				);
			}

			const entries = await this.wfmProvider.readDirectory(parentUri);
			if (parentUriString === 'wfm:/') {
				return entries.map(([name]) => {
					const childUri = vscode.Uri.joinPath(parentUri, name);
					if (name === 'workflows') {
						return new WfmWorkflowsFolderItem(childUri);
					}
					if (name === 'actions') {
						return new WfmActionsFolderItem(childUri);
					}
					if (name === 'templates') {
						return new WfmTemplatesFolderItem(childUri);
					}
					return new WfmTreeItem(name, childUri, vscode.FileType.Directory, vscode.TreeItemCollapsibleState.Collapsed);
				});
			}
			if (parentUriString === 'wfm:/workflows') {
				const sorted = entries.slice().sort(([a], [b]) => a.localeCompare(b));
				return sorted.map(([name]) =>
					new WfmWorkflowFolderItem(name, vscode.Uri.joinPath(parentUri, name))
				);
				/*return entries.map(([name]) =>
					new WfmWorkflowFolderItem(name, vscode.Uri.joinPath(parentUri, name))
				);*/
				return [];
			}
			if (parentUriString === 'wfm:/actions') {
				return entries.map(([name]) =>
					new WfmActionItem(name, vscode.Uri.joinPath(parentUri, name))
				);
			}
			if (parentUriString === 'wfm:/templates') {
				return entries.map(([name]) =>
					new WfmTemplateItem(name, vscode.Uri.joinPath(parentUri, name))
				);
			}
			return entries.map(([name, type]) => {
				const childUri = vscode.Uri.joinPath(parentUri, name);
				const isDir = type === vscode.FileType.Directory;
				return new WfmTreeItem(
					name,
					childUri,
					type,
					isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
				);
			});
		} catch (error) {
			console.error('[WFM Tree] Failed to load tree data', error);
			return [];
		}
	}
}

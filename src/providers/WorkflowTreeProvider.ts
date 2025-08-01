import * as vscode from 'vscode';
import { WorkflowManagerProvider } from './WorkflowManagerProvider';

class WorkflowTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly uri: vscode.Uri
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.resourceUri = uri;
        this.command = { command: 'vscode.open', title: 'Open Workflow', arguments: [uri] };
        this.contextValue = 'workflowItem';
    }
}

export class WorkflowTreeProvider implements vscode.TreeDataProvider<WorkflowTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<WorkflowTreeItem | undefined | void> = new vscode.EventEmitter();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private wfmProvider: WorkflowManagerProvider) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: WorkflowTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: WorkflowTreeItem): Promise<WorkflowTreeItem[]> {
        if (element) {
            return [];
        }

        try {
            await this.wfmProvider.readDirectory(vscode.Uri.parse('wfm:/workflows'));
        } catch (err) {
            return [];
        }

        const items: WorkflowTreeItem[] = [];
        for (const name of Object.keys(this.wfmProvider.workflow_folders)) {
            const uri = vscode.Uri.parse(`wfm:/workflows/${name}/${name}.yaml`);
            items.push(new WorkflowTreeItem(name, uri));
        }
        return items.sort((a, b) => a.label.localeCompare(b.label));
    }
}
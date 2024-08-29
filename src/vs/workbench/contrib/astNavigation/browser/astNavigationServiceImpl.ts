/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow } from 'vs/base/browser/dom';
import { CancellationToken } from 'vs/base/common/cancellation';
import { Disposable, DisposableStore, IDisposable } from 'vs/base/common/lifecycle';
import { ICodeEditor, isCodeEditor } from 'vs/editor/browser/editorBrowser';
import { ILanguageFeaturesService } from 'vs/editor/common/services/languageFeatures';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IEditorPane } from 'vs/workbench/common/editor';
import { CONTEXT_AST_NAVIGATION_MODE } from 'vs/workbench/contrib/astNavigation/common/astNavigationContextKeys';
import { IASTNavigationService } from 'vs/workbench/contrib/astNavigation/common/astNavigationService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IOutline, IOutlineService, OutlineTarget } from 'vs/workbench/services/outline/browser/outline';

class TreeNode<T> {
	element: T;
	children: TreeNode<T>[] = [];
	parent: TreeNode<T> | null = null;

	constructor(element: T) {
		this.element = element;
	}

	addChild(child: TreeNode<T>) {
		child.parent = this;
		this.children.push(child);
	}
}

export class ASTNavigationService extends Disposable implements IASTNavigationService {
	declare _serviceBrand: undefined;

	private readonly activeEditorDisposables = this._register(new DisposableStore());
	private activeOutline: IOutline<any> | undefined;
	private outlineRoot: TreeNode<any> | undefined;
	private currentNode: TreeNode<any> | undefined;
	private previewDisposable: IDisposable | undefined;

	private _astNavigationMode: IContextKey<boolean>;

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IEditorService private readonly editorService: IEditorService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IOutlineService private readonly outlineService: IOutlineService
	) {
		super();
		this._astNavigationMode = CONTEXT_AST_NAVIGATION_MODE.bindTo(this.contextKeyService);

		this._register(this.languageFeaturesService.documentSymbolProvider.onDidChange(() => this.recreateOutline()));
		this._register(this.editorService.onDidActiveEditorChange(() => this.recreateOutline()));
		this.recreateOutline();
	}

	private recreateOutline(): void {
		this.clearActiveOutline();
		const activeEditor = this.editorService.activeEditorPane;
		if (!activeEditor) {
			return;
		}

		this.renderActiveEditorOutline(activeEditor);
	}

	private clearActiveOutline(): void {
		this.outlineRoot = undefined;
		this.currentNode = undefined;
		this.activeOutline?.dispose();
		this.activeOutline = undefined;
		this.previewDisposable?.dispose();
		this.activeEditorDisposables.clear();
	}

	private previewNode(node: TreeNode<any>): void {
		this.currentNode = node;
		this.previewDisposable?.dispose();
		this.previewDisposable = this.activeOutline?.preview(node.element);
		const editor = this.editorService.activeTextEditorControl;
		if (isCodeEditor(editor)) {
			editor.setSelection(node.element.symbol.range);
		}
	}

	toggleASTNavigationMode(): void {
		const currentMode = this._astNavigationMode.get();
		const isAstNavigationMode = !currentMode;
		this._astNavigationMode.set(isAstNavigationMode);
		if (isAstNavigationMode) {
			getActiveWindow().document.body.classList.add('astNavigationMode');
			this.recreateOutline();
		} else {
			getActiveWindow().document.body.classList.remove('astNavigationMode');
			this.clearActiveOutline();
			const editor = this.editorService.activeTextEditorControl;
			if (isCodeEditor(editor)) {
				const selection = editor.getSelection();
				if (selection) {
					const endPosition = selection.getEndPosition();
					editor.setSelection({
						startLineNumber: endPosition.lineNumber,
						startColumn: endPosition.column,
						endLineNumber: endPosition.lineNumber,
						endColumn: endPosition.column
					});
				}
			}
		}
	}

	moveUp(): void {
		if (!this.currentNode || !this.currentNode.parent) {
			return;
		}

		const parentNode = this.currentNode.parent;
		const currentIndex = parentNode.children.indexOf(this.currentNode);

		if (currentIndex > 0) {
			this.previewNode(parentNode.children[currentIndex - 1]);
		} else if (parentNode.parent) {
			const grandParentNode = parentNode.parent;
			const parentIndex = grandParentNode.children.indexOf(parentNode);

			if (parentIndex > 0) {
				const previousSiblingNode = grandParentNode.children[parentIndex - 1];
				this.previewNode(previousSiblingNode);
			} else {
				this.previewNode(parentNode);
			}
		}
	}

	moveDown(): void {
		if (!this.currentNode || !this.currentNode.parent) {
			return;
		}

		const parentNode = this.currentNode.parent;
		const currentIndex = parentNode.children.indexOf(this.currentNode);

		if (currentIndex < parentNode.children.length - 1) {
			this.previewNode(parentNode.children[currentIndex + 1]);
		} else if (parentNode.parent) {
			const grandParentNode = parentNode.parent;
			const parentIndex = grandParentNode.children.indexOf(parentNode);

			if (parentIndex < grandParentNode.children.length - 1) {
				const nextSiblingNode = grandParentNode.children[parentIndex + 1];
				this.previewNode(nextSiblingNode);
			} else {
				this.previewNode(parentNode);
			}
		}
	}

	moveInto(): void {
		if (this.currentNode && this.currentNode.children.length > 0) {
			this.previewNode(this.currentNode.children[0]);
		}
	}

	moveOut(): void {
		if (this.currentNode && this.currentNode.parent?.element) {
			const parentNode = this.currentNode.parent;
			this.previewNode(parentNode);
		}
	}

	private async renderActiveEditorOutline(pane: IEditorPane): Promise<void> {
		const control = pane.getControl();
		let editor: ICodeEditor | undefined;
		if (isCodeEditor(control)) {
			editor = control;
		}
		if (!editor) {
			return;
		}
		const buffer = editor.getModel();
		if (!buffer) {
			return;
		}
		if (!this.languageFeaturesService.documentSymbolProvider.has(buffer)) {
			return;
		}

		const outline = this.activeOutline = await this.outlineService.createOutline(pane, OutlineTarget.Breadcrumbs, CancellationToken.None);
		if (!outline) {
			return;
		}
		this.activeEditorDisposables.add(outline);
		this.activeEditorDisposables.add(outline.onDidChange(e => {
			if (!this._astNavigationMode.get()) {
				return;
			}

			this.rebuildOutlineTree(outline);
			if (e.affectOnlyActiveElement) {
				const nodeAtCurrentPosition = this.getNodeAtCurrentPosition();
				if (nodeAtCurrentPosition) {
					this.previewNode(nodeAtCurrentPosition);
				}
			}
		}));

		this.rebuildOutlineTree(outline);
		if (this.outlineRoot) {
			const nodeAtCurrentPosition = this.getNodeAtCurrentPosition();
			this.previewNode(nodeAtCurrentPosition ?? this.outlineRoot.children[0]);
		}
	}

	private getNodeAtCurrentPosition(): TreeNode<any> | undefined {
		const breadcrumbElements = this.activeOutline?.config.breadcrumbsDataSource.getBreadcrumbElements();
		if (breadcrumbElements && breadcrumbElements.length > 0) {
			const lastBreadcrumbElement = breadcrumbElements[breadcrumbElements.length - 1];
			const lastBreadcrumbNode = this.findNodeByElement(this.outlineRoot!, lastBreadcrumbElement);
			return lastBreadcrumbNode;
		}

		return undefined;
	}

	private rebuildOutlineTree(outline: IOutline<any>): void {
		this.outlineRoot = this.buildTreeFromElements(Array.from(outline.config.treeDataSource.getChildren(outline)), new TreeNode<any>(null));
	}

	private buildTreeFromElements(elements: any[], root: TreeNode<any>): TreeNode<any> {
		for (const element of elements) {
			const node = new TreeNode(element);
			node.parent = root;
			root.addChild(node);
			const children = this.activeOutline?.config.treeDataSource.getChildren(element);
			if (children) {
				node.children = this.buildTreeFromElements(Array.from(children), node).children;
			}
		}
		return root;
	}

	private findNodeByElement(root: TreeNode<any>, element: any): TreeNode<any> | undefined {
		if (root.element?.id === element.id) {
			return root;
		}
		for (const child of root.children) {
			const found = this.findNodeByElement(child, element);
			if (found) {
				return found;
			}
		}
		return undefined;
	}
}

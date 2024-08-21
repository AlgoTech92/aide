/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { Button } from 'vs/base/browser/ui/button/button';
import { Event } from 'vs/base/common/event';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { ContentWidgetPositionPreference, ICodeEditor, IContentWidget, IContentWidgetPosition } from 'vs/editor/browser/editorBrowser';
import { IPosition } from 'vs/editor/common/core/position';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { defaultButtonStyles } from 'vs/platform/theme/browser/defaultStyles';

export const addContextCommandId = 'workbench.action.aideChat.addContext';
export const inlineChatCommandId = 'inlineChat.start';

export class KeybindingPillWidget extends Disposable implements IContentWidget {
	public static readonly ID = 'editor.contrib.keybindingPillWidget';

	private readonly _toDispose = new DisposableStore();
	private readonly _domNode: HTMLElement;

	private isVisible: boolean = false;
	private addContextButton: Button | undefined;
	private inlineChatButton: Button | undefined;

	private addContextLabel?: string;
	private inlineChatLabel?: string;

	constructor(
		private readonly _editor: ICodeEditor,
		@IKeybindingService keybindingService: IKeybindingService
	) {
		super();

		this._domNode = dom.$('div.keybindingPillWidget');
		this.renderButtons();
		this.updateLabels(keybindingService);

		this._register(Event.runAndSubscribe(keybindingService.onDidUpdateKeybindings, () => {
			this.updateLabels(keybindingService);
		}));
	}

	private renderButtons() {
		this.inlineChatButton = new Button(this._domNode, defaultButtonStyles);
		this.addContextButton = new Button(this._domNode, defaultButtonStyles);
		this._toDispose.add(this.inlineChatButton);
		this._toDispose.add(this.inlineChatButton.onDidClick(() => {
			this._editor.trigger('keyboard', inlineChatCommandId, null);
			this.hide();
		}));
		this._toDispose.add(this.addContextButton);
		this._toDispose.add(this.addContextButton.onDidClick(() => {
			this._editor.trigger('keyboard', addContextCommandId, null);
			this.hide();
		}));

		this.inlineChatButton.enabled = true;
		this.inlineChatButton.element.classList.add('keybinding-pill');
		this.addContextButton.enabled = true;
		this.addContextButton.element.classList.add('keybinding-pill');
	}

	private updateLabels(keybindingService: IKeybindingService) {
		this.addContextLabel = `${keybindingService.lookupKeybinding(addContextCommandId)?.getLabel() ?? ''} Add context`;
		if (this.addContextButton) {
			this.addContextButton.label = this.addContextLabel;
		}

		this.inlineChatLabel = `${keybindingService.lookupKeybinding(inlineChatCommandId)?.getLabel() ?? ''} Anchored editing`;
		if (this.inlineChatButton) {
			this.inlineChatButton.label = this.inlineChatLabel;
		}
	}

	override dispose(): void {
		super.dispose();
		this._toDispose.dispose();

		this.addContextButton = undefined;

		this._editor.removeContentWidget(this);
	}

	getId(): string {
		return 'KeybindingPillWidget';
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IContentWidgetPosition | null {
		const selection = this._editor.getSelection();
		if (!selection) {
			return null;
		}

		const selectionStartLine = selection.selectionStartLineNumber;
		if (selection.startLineNumber === selectionStartLine) {
			// this is from a top-to-bottom-selection
			// so we want to show the widget on the top
			return {
				position: {
					lineNumber: selectionStartLine,
					column: selection.startColumn,
				},
				preference: [ContentWidgetPositionPreference.ABOVE]
			};
		} else {
			// this is from bottom-to-top selection
			// so we want to return the position to the bottom
			return {
				position: {
					lineNumber: selection.endLineNumber,
					column: selection.endColumn,
				},
				preference: [ContentWidgetPositionPreference.BELOW],
			};
		}
	}

	showAt(position: IPosition) {
		if (this.isVisible) {
			this._editor.layoutContentWidget(this);
		} else {
			this._editor.addContentWidget(this);
		}
	}

	hide() {
		this._editor.removeContentWidget(this);
		this.isVisible = false;
	}
}

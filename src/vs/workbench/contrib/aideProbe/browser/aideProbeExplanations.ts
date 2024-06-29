/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { MarkdownRenderer } from 'vs/editor/browser/widget/markdownRenderer/browser/markdownRenderer';
import { Position } from 'vs/editor/common/core/position';
import { IRange } from 'vs/editor/common/core/range';
import { IModelDeltaDecoration } from 'vs/editor/common/model';
import { ITextEditorOptions, TextEditorSelectionRevealType } from 'vs/platform/editor/common/editor';
import { createDecorator, IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { editorFindMatch, editorFindMatchForeground } from 'vs/platform/theme/common/colorRegistry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { ChatMarkdownRenderer } from 'vs/workbench/contrib/aideChat/browser/aideChatMarkdownRenderer';
import { AideProbeExplanationWidget } from 'vs/workbench/contrib/aideProbe/browser/aideProbeExplanationWidget';
import { IAideProbeBreakdownViewModel, IAideProbeGoToDefinitionViewModel } from 'vs/workbench/contrib/aideProbe/browser/aideProbeViewModel';

const decorationDescription = 'chat-breakdown-definition';
const placeholderDecorationType = 'chat-breakdown-definition-session-detail';

export const IAideProbeExplanationService = createDecorator<IAideProbeExplanationService>('IAideProbeExplanationService');

export interface IAideProbeExplanationService {
	_serviceBrand: undefined;

	changeActiveBreakdown(content: IAideProbeBreakdownViewModel): void;
	clearBreakdowns(): void;
}

export class AideProbeExplanationService extends Disposable implements IAideProbeExplanationService {
	declare _serviceBrand: undefined;

	private readonly markdownRenderer: MarkdownRenderer;
	private explanationWidget: AideProbeExplanationWidget | undefined;
	private _goToDefinitionDecorations: string[] = [];

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IThemeService private readonly themeService: IThemeService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
	) {
		super();

		this.markdownRenderer = this.instantiationService.createInstance(ChatMarkdownRenderer, undefined);

		const theme = this.themeService.getColorTheme();
		const decorationBackgroundColor = theme.getColor(editorFindMatch);
		const decorationColor = theme.getColor(editorFindMatchForeground);

		this.codeEditorService.registerDecorationType(decorationDescription, placeholderDecorationType, {
			color: decorationColor?.toString() || '#f3f4f6',
			backgroundColor: decorationBackgroundColor?.toString() || '#1f2937',
			borderRadius: '3px',
		});
	}

	private openCodeEditor(uri: URI, selection?: IRange): Promise<ICodeEditor | null> {
		let options: ITextEditorOptions = {
			pinned: false,
			preserveFocus: true
		};

		if (selection) {
			options = {
				...options,
				selection,
				selectionRevealType: TextEditorSelectionRevealType.NearTop
			};
		}

		return this.codeEditorService.openCodeEditor({ resource: uri, options }, null);
	}

	async changeActiveBreakdown(element: IAideProbeBreakdownViewModel): Promise<void> {
		const { uri } = element;
		this.explanationWidget?.hide();
		this.explanationWidget?.dispose();

		let codeEditor: ICodeEditor | null;
		let breakdownPosition: Position = new Position(1, 300);

		const resolveLocationOperation = element.symbol;
		// this.editorProgressService.showWhile(resolveLocationOperation);
		const symbol = await resolveLocationOperation;

		if (!symbol) {
			codeEditor = await this.openCodeEditor(uri);
		} else {
			breakdownPosition = new Position(symbol.range.startLineNumber - 1, symbol.range.startColumn);
			codeEditor = await this.openCodeEditor(uri, symbol.range);
		}

		if (codeEditor && symbol && breakdownPosition) {
			this.explanationWidget = this._register(this.instantiationService.createInstance(AideProbeExplanationWidget, codeEditor, this.markdownRenderer));
			this.explanationWidget.setBreakdown(element);
			this.explanationWidget.show();
		}
	}

	async showGoToDefinition(definition: IAideProbeGoToDefinitionViewModel): Promise<void> {
		// we have the go-to-definitions, we want to highlight only on the file we are currently opening in the probebreakdownviewmodel
		const codeEditor = this.codeEditorService.getActiveCodeEditor();
		if (!codeEditor) {
			return;
		}

		codeEditor.changeDecorations((changeAccessor) => {
			const newDecorations: IModelDeltaDecoration[] = [{
				range: {
					startLineNumber: definition.range.startLineNumber,
					startColumn: definition.range.startColumn,
					endColumn: definition.range.endColumn + 1,
					endLineNumber: definition.range.endLineNumber
				},
				options: {
					description: decorationDescription,
					inlineClassName: placeholderDecorationType,
					hoverMessage: { value: definition.thinking },
				}
			}];
			this._goToDefinitionDecorations = changeAccessor.deltaDecorations(this._goToDefinitionDecorations, newDecorations);
		});
	}

	clearBreakdowns(): void {
		this.explanationWidget?.clearBreakdowns();
	}
}

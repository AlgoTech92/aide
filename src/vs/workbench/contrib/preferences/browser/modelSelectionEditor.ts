/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from 'vs/base/browser/dom';
import { ActionBar } from 'vs/base/browser/ui/actionbar/actionbar';
import { HighlightedLabel } from 'vs/base/browser/ui/highlightedlabel/highlightedLabel';
import { ISelectOptionItem, SelectBox } from 'vs/base/browser/ui/selectBox/selectBox';
import { ITableRenderer, ITableVirtualDelegate } from 'vs/base/browser/ui/table/table';
import { IAction } from 'vs/base/common/actions';
import { CancellationToken } from 'vs/base/common/cancellation';
import { ThemeIcon } from 'vs/base/common/themables';
import 'vs/css!./media/modelSelectionEditor';
import { localize } from 'vs/nls';
import { providerTypeValues } from 'vs/platform/aiModel/common/aiModels';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { IEditorOptions } from 'vs/platform/editor/common/editor';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { WorkbenchTable } from 'vs/platform/list/browser/listService';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { defaultSelectBoxStyles } from 'vs/platform/theme/browser/defaultStyles';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { EditorPane } from 'vs/workbench/browser/parts/editor/editorPane';
import { IEditorOpenContext } from 'vs/workbench/common/editor';
import { settingsCopyIcon, settingsEditIcon } from 'vs/workbench/contrib/preferences/browser/preferencesIcons';
import { IModelSelectionEditingService } from 'vs/workbench/services/aiModel/common/aiModelEditing';
import { ModelSelectionEditorInput } from 'vs/workbench/services/preferences/browser/modelSelectionEditorInput';
import { ModelSelectionEditorModel } from 'vs/workbench/services/preferences/browser/modelSelectionEditorModel';
import { IModelItemEntry, IProviderItemEntry } from 'vs/workbench/services/preferences/common/preferences';

const $ = DOM.$;

export class ModelSelectionEditor extends EditorPane {
	static readonly ID: string = 'workbench.editor.modelSelectionEditor';

	private modelSelectionEditorModel: ModelSelectionEditorModel | null = null;

	private headerContainer!: HTMLElement;
	private modelsTableContainer!: HTMLElement;
	private providersTableContainer!: HTMLElement;

	private fastModelSelect!: SelectBox;
	private slowModelSelect!: SelectBox;
	private modelsTable!: WorkbenchTable<IModelItemEntry>;
	private providersTable!: WorkbenchTable<IProviderItemEntry>;

	private dimension: DOM.Dimension | null = null;

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IModelSelectionEditingService private readonly modelSelectionEditingService: IModelSelectionEditingService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super(ModelSelectionEditor.ID, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const modelSelectionEditorElement = DOM.append(parent, $('div', { class: 'model-selection-editor' }));
		DOM.append(modelSelectionEditorElement, $('h2', undefined, 'Model Selection'));

		this.crateHeader(modelSelectionEditorElement);
		this.createBody(modelSelectionEditorElement);
	}

	private crateHeader(parent: HTMLElement): void {
		this.headerContainer = DOM.append(parent, $('.model-selection-header'));

		const fastModelContainer = DOM.append(this.headerContainer, $('.model-select-dropdown'));
		DOM.append(fastModelContainer, $('span', undefined, 'Fast Model'));
		this.fastModelSelect = new SelectBox(<ISelectOptionItem[]>[], 0, this.contextViewService, defaultSelectBoxStyles, { ariaLabel: localize('fastModel', 'Fast Model') });
		this.fastModelSelect.render(fastModelContainer);
		this._register(this.fastModelSelect.onDidSelect((e) => {
			this.setFastModel(e.selected);
		}));

		const slowModelContainer = DOM.append(this.headerContainer, $('.model-select-dropdown'));
		DOM.append(slowModelContainer, $('span', undefined, 'Slow Model'));
		this.slowModelSelect = new SelectBox(<ISelectOptionItem[]>[], 0, this.contextViewService, defaultSelectBoxStyles, { ariaLabel: localize('slowModel', 'Slow Model') });
		this.slowModelSelect.render(slowModelContainer);
		this._register(this.slowModelSelect.onDidSelect((e) => {
			this.setSlowModel(e.selected);
		}));
	}

	private createBody(parent: HTMLElement): void {
		const bodyContainer = DOM.append(parent, $('div', { class: 'model-selection-body' }));
		this.createModelsTable(bodyContainer);
		this.createProvidersTable(bodyContainer);
	}

	private createModelsTable(parent: HTMLElement): void {
		this.modelsTableContainer = DOM.append(parent, $('div', { class: 'table-container' }));
		DOM.append(this.modelsTableContainer, $('h3', undefined, 'Models'));
		this.modelsTable = this._register(this.instantiationService.createInstance(WorkbenchTable,
			'ModelSelectionEditor',
			this.modelsTableContainer,
			new ModelDelegate(),
			[
				{
					label: '',
					tooltip: '',
					weight: 0,
					minimumWidth: 40,
					maximumWidth: 40,
					templateId: ModelActionsColumnRenderer.TEMPLATE_ID,
					project(row: IModelItemEntry): IModelItemEntry { return row; }
				},
				{
					label: localize('model', "Model"),
					tooltip: '',
					weight: 0.3,
					templateId: ModelsColumnRenderer.TEMPLATE_ID,
					project(row: IModelItemEntry): IModelItemEntry { return row; }
				},
				{
					label: localize('provider', "Provider"),
					tooltip: '',
					weight: 0.3,
					templateId: ModelProvidersColumnRenderer.TEMPLATE_ID,
					project(row: IModelItemEntry): IModelItemEntry { return row; }
				},
				{
					label: localize('contextLength', "Context Length"),
					tooltip: '',
					weight: 0.2,
					templateId: ContextLengthColumnRenderer.TEMPLATE_ID,
					project(row: IModelItemEntry): IModelItemEntry { return row; }
				},
				{
					label: localize('temperature', "Temperature"),
					tooltip: '',
					weight: 0.2,
					templateId: TemperatureColumnRenderer.TEMPLATE_ID,
					project(row: IModelItemEntry): IModelItemEntry { return row; }
				}
			],
			[
				this.instantiationService.createInstance(ModelActionsColumnRenderer),
				this.instantiationService.createInstance(ModelsColumnRenderer),
				this.instantiationService.createInstance(ModelProvidersColumnRenderer),
				this.instantiationService.createInstance(ContextLengthColumnRenderer),
				this.instantiationService.createInstance(TemperatureColumnRenderer)
			],
			{
				identityProvider: { getId: (e: IModelItemEntry) => e.modelItem.key },
				horizontalScrolling: false,
				multipleSelectionSupport: false,
				setRowLineHeight: false,
				openOnSingleClick: false,
			}
		)) as WorkbenchTable<IModelItemEntry>;

		DOM.append(this.modelsTableContainer);
	}

	private createProvidersTable(parent: HTMLElement): void {
		this.providersTableContainer = DOM.append(parent, $('div', { class: 'table-container' }));
		DOM.append(this.providersTableContainer, $('h3', undefined, 'Providers'));
		this.providersTable = this._register(this.instantiationService.createInstance(WorkbenchTable,
			'ModelSelectionEditor',
			this.providersTableContainer,
			new ProviderDelegate(),
			[
				{
					label: '',
					tooltip: '',
					weight: 0,
					minimumWidth: 40,
					maximumWidth: 40,
					templateId: ModelActionsColumnRenderer.TEMPLATE_ID,
					project(row: IModelItemEntry): IModelItemEntry { return row; }
				},
				{
					label: localize('provider', "Provider"),
					tooltip: '',
					weight: 0.3,
					templateId: ProviderColumnsRenderer.TEMPLATE_ID,
					project(row: IProviderItemEntry): IProviderItemEntry { return row; }
				}
			],
			[
				this.instantiationService.createInstance(ProviderActionsColumnRenderer),
				this.instantiationService.createInstance(ProviderColumnsRenderer),
			],
			{
				identityProvider: { getId: (e: IProviderItemEntry) => e.providerItem.key },
				horizontalScrolling: false,
				multipleSelectionSupport: false,
				setRowLineHeight: false,
				openOnSingleClick: false,
			}
		)) as WorkbenchTable<IProviderItemEntry>;

		DOM.append(this.providersTableContainer);
	}

	private async render(): Promise<void> {
		if (this.input) {
			const input: ModelSelectionEditorInput = this.input as ModelSelectionEditorInput;
			this.modelSelectionEditorModel = await input.resolve();
			await this.modelSelectionEditorModel.resolve();

			this.renderProviders();
			this.renderModels();
			this.layoutTables();
		}
	}

	private renderModels(): void {
		if (this.modelSelectionEditorModel) {
			const modelItems = this.modelSelectionEditorModel.modelItems;

			this.fastModelSelect.setOptions(modelItems.map(items => ({ text: items.modelItem.name }) as ISelectOptionItem));
			this.fastModelSelect.select(modelItems.findIndex(items => items.modelItem.key === this.modelSelectionEditorModel?.fastModel.modelItem.key));
			this.slowModelSelect.setOptions(modelItems.map(tems => ({ text: tems.modelItem.name }) as ISelectOptionItem));
			this.slowModelSelect.select(modelItems.findIndex(items => items.modelItem.key === this.modelSelectionEditorModel?.slowModel.modelItem.key));

			this.modelsTable.splice(0, this.modelsTable.length, modelItems);
		}
	}

	private renderProviders(): void {
		if (this.modelSelectionEditorModel) {
			const providerItems = this.modelSelectionEditorModel.providerItems;
			this.providersTable.splice(0, this.providersTable.length, providerItems);
		}
	}

	private layoutTables(): void {
		if (!this.dimension) {
			return;
		}

		this.modelsTable.layout();
		this.providersTable.layout();
	}

	// Note: This is indeed the model name and not key. For some reason, SelectBox does not support setting a value.
	private async setSlowModel(modelName: string): Promise<void> {
		const modelKey = this.modelSelectionEditorModel?.modelItems.find(model => model.modelItem.name === modelName)?.modelItem.key;
		if (!modelKey) {
			return;
		}
		await this.modelSelectionEditingService.editModel('slowModel', modelKey);
	}

	// Note: This is indeed the model name and not key. For some reason, SelectBox does not support setting a value.
	private async setFastModel(modelName: string): Promise<void> {
		const modelKey = this.modelSelectionEditorModel?.modelItems.find(model => model.modelItem.name === modelName)?.modelItem.key;
		if (!modelKey) {
			return;
		}
		await this.modelSelectionEditingService.editModel('fastModel', modelKey);
	}

	override async setInput(input: ModelSelectionEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		return await this.render();
	}

	layout(dimension: DOM.Dimension): void {
		this.dimension = dimension;

		this.layoutTables();
	}
}

class ModelDelegate implements ITableVirtualDelegate<IModelItemEntry> {
	readonly headerRowHeight = 30;

	getHeight(element: IModelItemEntry): number {
		return 24;
	}
}

class ProviderDelegate implements ITableVirtualDelegate<IProviderItemEntry> {
	readonly headerRowHeight = 30;

	getHeight(element: IProviderItemEntry): number {
		return 24;
	}
}

interface IModelActionsColumnTemplateData {
	readonly actionBar: ActionBar;
}

class ModelActionsColumnRenderer implements ITableRenderer<IModelItemEntry, IModelActionsColumnTemplateData> {

	static readonly TEMPLATE_ID = 'modelActions';

	readonly templateId: string = ModelActionsColumnRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IModelActionsColumnTemplateData {
		const element = DOM.append(container, $('.actions'));
		const actionBar = new ActionBar(element, { animated: false });
		return { actionBar };
	}

	renderElement(modelSelectionItemEntry: IModelItemEntry, index: number, templateData: IModelActionsColumnTemplateData, height: number | undefined): void {
		templateData.actionBar.clear();
		const actions: IAction[] = [];
		actions.push(this.createEditAction());
		templateData.actionBar.push(actions, { icon: true });
	}

	private createEditAction(): IAction {
		return <IAction>{
			class: ThemeIcon.asClassName(settingsEditIcon),
			enabled: true,
			id: 'editModelSelection',
			tooltip: localize('editModel', "Edit Model"),
		};
	}

	disposeTemplate(templateData: IModelActionsColumnTemplateData): void {
		templateData.actionBar.dispose();
	}
}

interface IModelColumnTemplateData {
	modelColumn: HTMLElement;
	modelLabelContainer: HTMLElement;
	modelLabel: HighlightedLabel;
}

class ModelsColumnRenderer implements ITableRenderer<IModelItemEntry, IModelColumnTemplateData> {
	static readonly TEMPLATE_ID = 'model';

	readonly templateId: string = ModelsColumnRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IModelColumnTemplateData {
		const modelColumn = DOM.append(container, $('.model'));
		const modelLabelContainer = DOM.append(modelColumn, $('.model-label'));
		const modelLabel = new HighlightedLabel(modelLabelContainer);
		return { modelColumn, modelLabelContainer, modelLabel };
	}

	renderElement(modelItemEntry: IModelItemEntry, index: number, templateData: IModelColumnTemplateData): void {
		const modelItem = modelItemEntry.modelItem;
		templateData.modelColumn.title = modelItem.name;

		if (modelItem.name) {
			templateData.modelLabelContainer.classList.remove('hide');
			templateData.modelLabel.set(modelItem.name, []);
		} else {
			templateData.modelLabelContainer.classList.add('hide');
			templateData.modelLabel.set(undefined);
		}
	}

	disposeTemplate(templateData: IModelColumnTemplateData): void { }
}

interface IModelProviderColumnTemplateData {
	modelProviderColumn: HTMLElement;
	providerLabelContainer: HTMLElement;
	providerLabel: HighlightedLabel;
}

class ModelProvidersColumnRenderer implements ITableRenderer<IModelItemEntry, IModelProviderColumnTemplateData> {
	static readonly TEMPLATE_ID = 'modelProvider';

	readonly templateId: string = ModelProvidersColumnRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IModelProviderColumnTemplateData {
		const modelProviderColumn = DOM.append(container, $('.model-provider'));
		const providerLabelContainer = DOM.append(modelProviderColumn, $('.provider-label'));
		const providerLabel = new HighlightedLabel(providerLabelContainer);
		return { modelProviderColumn, providerLabelContainer, providerLabel };
	}

	renderElement(modelItemEntry: IModelItemEntry, index: number, templateData: IModelProviderColumnTemplateData): void {
		const modelItem = modelItemEntry.modelItem;
		templateData.modelProviderColumn.title = modelItem.name;

		if (modelItem.provider) {
			templateData.providerLabelContainer.classList.remove('hide');
			templateData.providerLabel.set(modelItem.provider, []);
		} else {
			templateData.providerLabelContainer.classList.add('hide');
			templateData.providerLabel.set(undefined);
		}
	}

	disposeTemplate(templateData: IModelProviderColumnTemplateData): void { }
}

interface IContextLengthColumnTemplateData {
	contextLengthColumn: HTMLElement;
	contextLengthLabelContainer: HTMLElement;
	contextLengthLabel: HTMLElement;
}

class ContextLengthColumnRenderer implements ITableRenderer<IModelItemEntry, IContextLengthColumnTemplateData> {
	static readonly TEMPLATE_ID = 'contextLength';

	readonly templateId: string = ContextLengthColumnRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IContextLengthColumnTemplateData {
		const contextLengthColumn = DOM.append(container, $('.context-length'));
		const contextLengthLabelContainer = DOM.append(contextLengthColumn, $('.context-length-label'));
		const contextLengthLabel = DOM.append(contextLengthLabelContainer, $('span'));
		return { contextLengthColumn, contextLengthLabelContainer, contextLengthLabel };
	}

	renderElement(modelItemEntry: IModelItemEntry, index: number, templateData: IContextLengthColumnTemplateData): void {
		const modelItem = modelItemEntry.modelItem;
		templateData.contextLengthColumn.title = modelItem.contextLength.toString();

		if (modelItem.contextLength) {
			templateData.contextLengthLabelContainer.classList.remove('hide');
			templateData.contextLengthLabel.innerText = modelItem.contextLength.toString();
		} else {
			templateData.contextLengthLabelContainer.classList.add('hide');
			templateData.contextLengthLabel.innerText = '';
		}
	}

	disposeTemplate(templateData: IContextLengthColumnTemplateData): void { }
}

interface ITemperatureColumnTemplateData {
	temperatureColumn: HTMLElement;
	temperatureLabelContainer: HTMLElement;
	temperatureLabel: HTMLElement;
}

class TemperatureColumnRenderer implements ITableRenderer<IModelItemEntry, ITemperatureColumnTemplateData> {
	static readonly TEMPLATE_ID = 'temperature';

	readonly templateId: string = TemperatureColumnRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): ITemperatureColumnTemplateData {
		const temperatureColumn = DOM.append(container, $('.temperature'));
		const temperatureLabelContainer = DOM.append(temperatureColumn, $('.temperature-label'));
		const temperatureLabel = DOM.append(temperatureLabelContainer, $('span'));
		return { temperatureColumn, temperatureLabelContainer, temperatureLabel };
	}

	renderElement(modelItemEntry: IModelItemEntry, index: number, templateData: ITemperatureColumnTemplateData): void {
		const modelItem = modelItemEntry.modelItem;
		templateData.temperatureColumn.title = modelItem.temperature.toString();

		if (modelItem.temperature) {
			templateData.temperatureLabelContainer.classList.remove('hide');
			templateData.temperatureLabel.innerText = modelItem.temperature.toString();
		} else {
			templateData.temperatureLabelContainer.classList.add('hide');
			templateData.temperatureLabel.innerText = '';
		}
	}

	disposeTemplate(templateData: ITemperatureColumnTemplateData): void { }
}

interface IProviderActionsColumnTemplateData {
	readonly actionBar: ActionBar;
}

class ProviderActionsColumnRenderer implements ITableRenderer<IModelItemEntry, IProviderActionsColumnTemplateData> {

	static readonly TEMPLATE_ID = 'providerActions';

	readonly templateId: string = ModelActionsColumnRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IProviderActionsColumnTemplateData {
		const element = DOM.append(container, $('.actions'));
		const actionBar = new ActionBar(element, { animated: false });
		return { actionBar };
	}

	renderElement(modelSelectionItemEntry: IModelItemEntry, index: number, templateData: IProviderActionsColumnTemplateData, height: number | undefined): void {
		templateData.actionBar.clear();
		const actions: IAction[] = [];
		actions.push(this.createCloneAction());
		templateData.actionBar.push(actions, { icon: true });
	}

	private createCloneAction(): IAction {
		return <IAction>{
			class: ThemeIcon.asClassName(settingsCopyIcon),
			enabled: true,
			id: 'cloneProviderSelection',
			tooltip: localize('cloneProvider', "Clone Provider"),
		};
	}

	disposeTemplate(templateData: IProviderActionsColumnTemplateData): void {
		templateData.actionBar.dispose();
	}
}

interface IProviderColumnTemplateData {
	providerColumn: HTMLElement;
	providerLogo: HTMLElement;
	providerLabelContainer: HTMLElement;
	providerLabel: HighlightedLabel;
}

class ProviderColumnsRenderer implements ITableRenderer<IProviderItemEntry, IProviderColumnTemplateData> {
	static readonly TEMPLATE_ID = 'provider';

	readonly templateId: string = ProviderColumnsRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IProviderColumnTemplateData {
		const providerColumn = DOM.append(container, $('.provider'));
		const providerLogo = DOM.append(providerColumn, $('.provider-logo'));
		const providerLabelContainer = DOM.append(providerColumn, $('.provider-label'));
		const providerLabel = new HighlightedLabel(providerLabelContainer);
		return { providerColumn, providerLogo, providerLabelContainer, providerLabel };
	}

	renderElement(providerItemEntry: IProviderItemEntry, index: number, templateData: IProviderColumnTemplateData): void {
		const providerItem = providerItemEntry.providerItem;
		templateData.providerColumn.title = providerItem.name;

		if (providerItem.name) {
			templateData.providerLabelContainer.classList.remove('hide');
			if (providerTypeValues.includes(providerItem.key)) {
				templateData.providerLogo.classList.add(providerItem.key);
			}
			templateData.providerLabel.set(providerItem.name, []);
		} else {
			templateData.providerLabelContainer.classList.remove(providerItem.key);
			templateData.providerLabelContainer.classList.add('hide');
			templateData.providerLabel.set(undefined);
		}
	}

	disposeTemplate(templateData: IProviderColumnTemplateData): void { }
}

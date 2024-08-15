/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchLayoutService, Parts } from 'vs/workbench/services/layout/browser/layoutService';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { MultiWindowParts, Part } from 'vs/workbench/browser/part';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IDisposable } from 'vs/base/common/lifecycle';
import { $, append } from 'vs/base/browser/dom';
import { IAideControlsPartService } from 'vs/workbench/services/aideControlsPart/browser/aideControlsPartService';

export class AideControlsPartService extends MultiWindowParts<AideControlsPart> implements IAideControlsPartService {

	declare _serviceBrand: undefined;

	readonly mainPart = this._register(this.instantiationService.createInstance(AideControlsPart));

	constructor(
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@IThemeService themeService: IThemeService,
	) {
		super('workbench.aideControlsPartService', themeService, storageService);

		this._register(this.registerPart(this.mainPart));
	}

	createAuxiliaryControlsPart(container: HTMLElement, editorContainer: HTMLElement): AideControlsPart {
		const aideControlsPartContainer = document.createElement('div');
		const aideControlsPart = this.instantiationService.createInstance(AideControlsPart);
		this._register(aideControlsPart);
		aideControlsPartContainer.classList.add('part', 'aidecontrols');
		container.insertBefore(aideControlsPartContainer, editorContainer.nextSibling);
		return aideControlsPart;
	}
}

export type AideControlsPosition = {
	bottom: number;
	left: number;
};


export class AideControlsPart extends Part implements IDisposable {

	static readonly activePanelSettingsKey = 'workbench.aidecontrols.activepanelid';


	private _content!: HTMLElement;
	get content(): HTMLElement {
		return this._content;
	}


	readonly minimumWidth: number = 200;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;

	readonly minimumHeight: number = 36;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	constructor(
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IThemeService themeService: IThemeService,
	) {
		super(
			Parts.AIDECONTROLS_PART,
			{ hasTitle: false },
			themeService,
			storageService,
			layoutService
		);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		this._content = append(this.element, $('.content'));
		return this._content;
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
		super.layoutContents(width, height);
	}

	get snap() {
		return false;
	}

	toJSON(): object {
		return {
			type: Parts.AIDECONTROLS_PART,
		};
	}
}

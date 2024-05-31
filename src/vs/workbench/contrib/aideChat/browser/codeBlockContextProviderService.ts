/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { ICodeBlockActionContextProvider, IAideChatCodeBlockContextProviderService } from 'vs/workbench/contrib/aideChat/browser/aideChat';

export class ChatCodeBlockContextProviderService implements IAideChatCodeBlockContextProviderService {
	declare _serviceBrand: undefined;
	private readonly _providers = new Map<string, ICodeBlockActionContextProvider>();

	get providers(): ICodeBlockActionContextProvider[] {
		return [...this._providers.values()];
	}
	registerProvider(provider: ICodeBlockActionContextProvider, id: string): IDisposable {
		this._providers.set(id, provider);
		return toDisposable(() => this._providers.delete(id));
	}
}

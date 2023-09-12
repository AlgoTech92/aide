/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CodeSnippetSearchInformation, CodeSearchIndexLoadStatus, CodeSearchIndexer } from './types';


const shouldRunIndexing = (indexerState: CodeSearchIndexLoadStatus): boolean => {
	if (indexerState === CodeSearchIndexLoadStatus.Loaded) {
		return false;
	}
	return true;
};


export class SearchIndexCollection {
	private _indexers: CodeSearchIndexer[];
	constructor() {
		this._indexers = [];
	}

	public addIndexer(indexer: CodeSearchIndexer) {
		this._indexers.push(indexer);
	}

	public async startupIndexers(filesToIndex: string[]) {
		// startup things here
		for (const indexer of this._indexers) {
			const isReady = await indexer.isReadyForUse();
			if (isReady) {
				continue;
			}
			// We are not marking this as async because we want this to run in
			// the background while the other indexers are also starting up
			indexer.loadFromStorage(filesToIndex).then((loadedFromStorage) => {
				if (shouldRunIndexing(loadedFromStorage.status)) {
					indexer.indexWorkspace(filesToIndex);
				}
				const missingFiles = loadedFromStorage.filesMissing;
				for (const missingFile of missingFiles) {
					indexer.indexFile(missingFile);
				}
			});
		}
	}

	public async searchQuery(query: string, limit: number): Promise<CodeSnippetSearchInformation[]> {
		for (const indexer of this._indexers) {
			const isReady = await indexer.isReadyForUse();
			if (!isReady) {
				continue;
			}
			// This is wrong here, we should be combining the results from
			// all the indexers, but for now its fine
			const results = await indexer.search(query, limit);
			if (results.length > 0) {
				return results;
			}
		}
		return [];
	}
}

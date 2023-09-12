/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What's fast indexing?
// Fast indexing is us looking at the code symbols present in a file using the
// DocumentSymbolProvider API. We use this to build a summary of the file
// and do a fast search.
// This will allow us to search for things quickly before we do a real search
// based on the code symbols.
// We need to make sure that this is really fast and run some benchmarks to make
// sure we are not blocking the extension in any way.

import { DocumentSymbol, SymbolInformation, SymbolKind, TextDocument, languages, workspace } from 'vscode';
import { CodeSearchFileInformation, CodeSearchIndexLoadResult, CodeSearchIndexLoadStatus, CodeSearchIndexer } from './types';

import * as path from 'path';
import * as fs from 'fs';
import math from 'mathjs';
import { generateEmbeddingFromSentenceTransformers } from '../llm/embeddings/sentenceTransformers';


const cosineSimilarity = (vecA: number[], vecB: number[]): number => {
	if (vecA.length !== vecB.length) {
		return -1;
	}

	const dotProduct = math.dot(vecA, vecB);
	const magnitudeA = math.norm(vecA);
	const magnitudeB = math.norm(vecB);

	return dotProduct / ((magnitudeA as number) * (magnitudeB as number));
}


// TODO(codestory): Why 5? Its a good number I guess but also gives a good representation of the
// overall structure of the file, we should tweak it per language, for example in
// rust we also have tests in the same file and mod tests will show up here too.
const MAX_NUM_OF_SYMBOLS = 5;


const TIMED_OUT = 'Timed out';

// TODO(codestory): Take language into account and return a new priority
// for it later on
const getPriorityForSymbolKind = (kind: SymbolKind): number => {
	if (SymbolKind.Module === kind) {
		return 1;
	}
	if (SymbolKind.Namespace === kind) {
		return 2;
	}
	if (SymbolKind.Class === kind) {
		return 3;
	}
	if (SymbolKind.Interface === kind) {
		return 4;
	}
	if (SymbolKind.Function === kind) {
		return 5;
	}
	if (SymbolKind.Method === kind) {
		return 6;
	}
	if (SymbolKind.Variable === kind) {
		return 7;
	}
	if (SymbolKind.Constant === kind) {
		return 8;
	}
	if (SymbolKind.Enum === kind) {
		return 10;
	}
	if (SymbolKind.Property === kind) {
		return 11;
	}
	return 5;
};


const sortDocumentSymbolsByKind = (symbols: DocumentSymbol[]): DocumentSymbol[] => {
	// Sort the tags by priority, fallback to their original order for equal priorities
	const sortedSymbols = symbols.sort((a, b) => {
		const priorityA = getPriorityForSymbolKind(a.kind);
		const priorityB = getPriorityForSymbolKind(b.kind);

		if (priorityA === priorityB) {
			return symbols.indexOf(a) - symbols.indexOf(b);
		} else {
			return priorityA - priorityB;
		}
	});
	return sortedSymbols;
};


const filterOurDocumentSymbols = (symbols: DocumentSymbol[]): DocumentSymbol[] => {
	return Array.from(symbols.filter((symbol) => {
		if (symbol.kind === SymbolKind.Variable) {
			return false;
		}
		// If the signature is pretty small, we can ignore it
		if (symbol.detail !== '' && symbol.detail.length <= 10) {
			return false;
		}
		return true;
	}));
};


const getFileRepresentation = (symbols: DocumentSymbol[], filePath: string): string => {
	const finalSymbolsToUse = sortDocumentSymbolsByKind(
		filterOurDocumentSymbols(symbols),
	).splice(MAX_NUM_OF_SYMBOLS);
	let representationString = `${filePath}\n`;
	for (let index = 0; index < finalSymbolsToUse.length; index++) {
		const symbol = finalSymbolsToUse[index];
		let symbolInformation = '';
		if (symbol.detail !== '') {
			symbolInformation = `${SymbolKind[symbol.kind]} ${symbol.name}:${symbol.detail}\n`;
		} else {
			symbolInformation = `${SymbolKind[symbol.kind]} ${symbol.name}\n`;
		}
		representationString += symbolInformation;
	}
	return representationString;
};


export interface DocumentSymbolIndex {
	filePath: string;
	fileRepresentationString: string;
	embeddings: number[];
	timestamp: number;
}


export class DocumentSymbolBasedIndex extends CodeSearchIndexer {
	private fileToIndexMap: Map<string, DocumentSymbolIndex> = new Map();
	private _readyToUse: boolean = false;
	private _storageLocation: string;
	constructor(globalStorageLocation: string) {
		super();
		this._storageLocation = globalStorageLocation;
		this.fileToIndexMap = new Map();
	}

	async indexFile(filePath: string) {
		// create an index for this file
		let textDocument: TextDocument | undefined;
		const timeout = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms, TIMED_OUT));
		workspace.textDocuments.forEach((document) => {
			if (document.uri.fsPath === filePath) {
				textDocument = document;
			}
		});
		if (!textDocument) {
			return;
		}
		const documentSymbolProviders = languages.getDocumentSymbolProvider(
			// Placeholder text here, we don't really filter for anything
			// here
			'typescript'
		);

		for (let index = 0; index < documentSymbolProviders.length; index++) {
			try {
				const symbols = await Promise.race([
					documentSymbolProviders[index].provideDocumentSymbols(
						textDocument,
						{
							isCancellationRequested: false,
							onCancellationRequested: () => ({ dispose() { } }),
						},
					),
					timeout(3000)
				]);

				// if promise timed out, continue to next iteration
				if (symbols === TIMED_OUT) {
					continue;
				}

				const castedSymbols = symbols as DocumentSymbol[] | undefined | null;
				if (castedSymbols === undefined || castedSymbols === null) {
					continue;
				}
				if (castedSymbols.length === 0) {
					continue;
				}
				const representationString = getFileRepresentation(castedSymbols, filePath);
				const embeddings = await generateEmbeddingFromSentenceTransformers(representationString);
				const documentSymbolIndexForFile: DocumentSymbolIndex = {
					filePath,
					fileRepresentationString: representationString,
					embeddings: embeddings,
					timestamp: Date.now(),
				}
				this.fileToIndexMap.set(filePath, documentSymbolIndexForFile);
				// Now we have to take this array and convert it to a representation
				// of the symbol which will work
				this._saveSingleFile(documentSymbolIndexForFile);
			} catch (e) {
				console.log('[DocumentSymbolBasedIndex] Error while indexing file');
				console.error(e);
			}
		}
	}

	async loadFromStorage(filesToTrack: string[]): Promise<CodeSearchIndexLoadResult> {
		const storagePath = path.join(this._storageLocation, 'documentSymbolBasedIndex');
		// Now we can walk on the directory only if it exists and then read all the content,
		// if the directory does not exist yet then we skip this step and try to
		// create the index
		try {
			const directoryExists = await fs.promises.access(storagePath, fs.constants.F_OK);
		} catch (e) {
			return {
				status: CodeSearchIndexLoadStatus.NotPresent,
				filesMissing: filesToTrack,
			};
		}


		// Now we will walk all the files in the directory and read them and get
		// the map going
		const files = await fs.promises.readdir(storagePath);
		const filesRead: Set<string> = new Set();
		for (let index = 0; index < files.length; index++) {
			const filePath = files[index];
			// now read the content of the file
			const fileContent = await fs.promises.readFile(
				path.join(storagePath, filePath),
				'utf8',
			);
			filesRead.add(path.join(storagePath, filePath));
			const documentSymbolIndex = JSON.parse(fileContent) as DocumentSymbolIndex;
			this.fileToIndexMap.set(documentSymbolIndex.filePath, documentSymbolIndex);
		}
		// Now return the files which are not present anymore, the edited
		// files will be taken care of later on
		return {
			status: CodeSearchIndexLoadStatus.Loaded,
			filesMissing: Array.from(filesToTrack.filter((file) => {
				if (filesRead.has(file)) {
					return false;
				}
				return true;
			}))
		};
	}


	async _saveSingleFile(documentSymbolIndex: DocumentSymbolIndex): Promise<void> {
		const storagePath = path.join(this._storageLocation, 'documentSymbolBasedIndex');
		const filePath = path.join(storagePath, documentSymbolIndex.filePath);
		// Create the path if it does not exist
		try {
			await fs.promises.mkdir(storagePath, { recursive: true });
		} catch (e) {
			// We will ignore this error for now
			return;
		}
		// Now we can write the file
		await fs.promises.writeFile(filePath, JSON.stringify(documentSymbolIndex));
	}

	async saveToStorage(): Promise<void> {
		// We will iterate through the map and write it to the disk
		for (const [_, documentSymbolIndex] of this.fileToIndexMap.entries()) {
			await this._saveSingleFile(documentSymbolIndex);
		}
		return;
	}

	async refreshIndex(): Promise<void> {
		// Implement this later on, once we figure out how to refresh the index
		// once we are done with keeping track of the state of the file which
		// we have already indexed
		return;
	}

	async search(query: string, limit: number): Promise<CodeSearchFileInformation[]> {
		// Now we have to search for the files which are relevant to the query
		const userQueryEmbeddings = await generateEmbeddingFromSentenceTransformers(query);
		const finalValues: CodeSearchFileInformation[] = [];
		for (const [filePath, documentSymbolIndex] of this.fileToIndexMap.entries()) {
			const embeddings = documentSymbolIndex.embeddings;
			const cosineSimilarityBetween = cosineSimilarity(
				userQueryEmbeddings,
				embeddings,
			);
			finalValues.push({
				filePath,
				score: cosineSimilarityBetween,
			});
		}
		return finalValues.sort((a, b) => {
			return b.score - a.score;
		}).splice(0, limit);
	}

	async isReadyForUse(): Promise<boolean> {
		// return something here
		return this._readyToUse;
	}

	async indexWorkspace(filesToIndex: string[]): Promise<void> {
		for (let index = 0; index < filesToIndex.length; index++) {
			const file = filesToIndex[index];
			await this.indexFile(file);
			if (this.fileToIndexMap.get(file)) {
				continue;
			}
			await this._saveSingleFile(this.fileToIndexMap.get(file)!);
		}
		this._readyToUse = true;
	}
}

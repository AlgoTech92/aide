/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as os from 'os';
import { commands, csevents, env, ExtensionContext, languages, modelSelection, window, workspace, } from 'vscode';

import { createInlineCompletionItemProvider } from './completions/create-inline-completion-item-provider';
import { CSChatAgentProvider } from './completions/providers/chatprovider';
import { AideProbeProvider } from './completions/providers/probeProvider';
import { getGitCurrentHash, getGitRepoName } from './git/helper';
import { aideCommands } from './inlineCompletion/commands';
import { startupStatusBar } from './inlineCompletion/statusBar';
import logger from './logger';
import postHogClient from './posthog/client';
import { AideQuickFix } from './quickActions/fix';
import { RepoRef, RepoRefBackend, SideCarClient } from './sidecar/client';
import { loadOrSaveToStorage } from './storage/types';
import { activateExtensions, getExtensionsInDirectory } from './utilities/activateLSP';
import { copySettings } from './utilities/copySettings';
import { getRelevantFiles, shouldTrackFile } from './utilities/openTabs';
import { checkReadonlyFSMode } from './utilities/readonlyFS';
import { reportIndexingPercentage } from './utilities/reportIndexingUpdate';
import { startSidecarBinary } from './utilities/setupSidecarBinary';
import { getSymbolNavigationActionTypeLabel } from './utilities/stringifyEvent';
import { readCustomSystemInstruction } from './utilities/systemInstruction';
import { CodeSymbolInformationEmbeddings } from './utilities/types';
import { getUniqueId, getUserId } from './utilities/uniqueId';
import { ProjectContext } from './utilities/workspaceContext';


export let SIDECAR_CLIENT: SideCarClient | null = null;

export async function activate(context: ExtensionContext) {
	// Project root here
	const uniqueUserId = getUniqueId();
	const userId = getUserId();
	console.log('User id:' + userId);
	logger.info(`[CodeStory]: ${uniqueUserId} Activating extension with storage: ${context.globalStorageUri}`);
	postHogClient?.capture({
		distinctId: getUniqueId(),
		event: 'extension_activated',
		properties: {
			platform: os.platform(),
		},
	});
	const appDataPath = process.env.APPDATA;
	const userProfilePath = process.env.USERPROFILE;
	console.log('appDataPath', appDataPath);
	console.log('userProfilePath', userProfilePath);
	const registerPreCopyCommand = commands.registerCommand(
		'webview.preCopySettings',
		async () => {
			await copySettings(env.appRoot, logger);
		}
	);
	context.subscriptions.push(registerPreCopyCommand);
	let rootPath = workspace.rootPath;
	if (!rootPath) {
		rootPath = '';
	}

	// Create the copy settings from vscode command for the extension
	const registerCopySettingsCommand = commands.registerCommand(
		'webview.copySettings',
		async () => {
			await copySettings(rootPath ?? '', logger);
		}
	);
	context.subscriptions.push(registerCopySettingsCommand);
	const readonlyFS = checkReadonlyFSMode();
	if (readonlyFS) {
		window.showErrorMessage('Move Aide to the Applications folder using Finder. More instructions here: [link](https://docs.codestory.ai/troubleshooting#macos-readonlyfs-warning)');
		return;
	}
	const agentSystemInstruction = readCustomSystemInstruction();
	if (agentSystemInstruction === null) {
		console.log(
			'Aide can help you better if you give it custom instructions by going to your settings and setting it in aide.systemInstruction (search for this string in User Settings) and reload vscode for this to take effect by doing Cmd+Shift+P: Developer: Reload Window'
		);
	}
	// Activate the LSP extensions which are needed for things to work
	await activateExtensions(context, getExtensionsInDirectory(rootPath));

	// Now we get all the required information and log it
	const repoName = await getGitRepoName(
		rootPath,
	);
	const repoHash = await getGitCurrentHash(
		rootPath,
	);

	// We also get some context about the workspace we are in and what we are
	// upto
	const projectContext = new ProjectContext();
	await projectContext.collectContext();

	postHogClient?.capture({
		distinctId: await getUniqueId(),
		event: 'activated_lsp',
		properties: {
			repoName,
			repoHash,
		}
	});


	csevents.registerCSEventHandler({
		handleSymbolNavigation(event) {
			const currentWindow = window.activeTextEditor?.document.uri.fsPath;
			postHogClient?.capture({
				distinctId: getUniqueId(),
				event: 'symbol_navigation',
				properties: {
					action: getSymbolNavigationActionTypeLabel(event.action),
					file_path: event.uri.fsPath,
					current_window: currentWindow,
				},
			});
			console.log('Received symbol navigation event!');
			console.log(event);
		},
	});

	// Get model selection configuration
	const modelConfiguration = await modelSelection.getConfiguration();
	const execPath = process.execPath;
	console.log('Exec path:' + execPath);
	console.log('Model configuration:' + JSON.stringify(modelConfiguration));
	// Setup the sidecar client here
	const sidecarUrl = await startSidecarBinary(context.globalStorageUri.fsPath, env.appRoot);
	// allow-any-unicode-next-line
	// window.showInformationMessage(`Sidecar binary 🦀 started at ${sidecarUrl}`);
	const sidecarClient = new SideCarClient(sidecarUrl, modelConfiguration);
	SIDECAR_CLIENT = sidecarClient;

	// we want to send the open tabs here to the sidecar
	const openTextDocuments = await getRelevantFiles();
	openTextDocuments.forEach((openTextDocument) => {
		// not awaiting here so we can keep loading the extension in the background
		if (shouldTrackFile(openTextDocument.uri)) {
			sidecarClient.documentOpen(openTextDocument.uri.fsPath, openTextDocument.contents, openTextDocument.language);
		}
	});
	// Setup the current repo representation here
	const currentRepo = new RepoRef(
		// We assume the root-path is the one we are interested in
		rootPath,
		RepoRefBackend.local,
	);
	// setup the callback for the model configuration
	modelSelection.onDidChangeConfiguration((config) => {
		sidecarClient.updateModelConfiguration(config);
		console.log('Model configuration updated:' + JSON.stringify(config));
	});
	await sidecarClient.indexRepositoryIfNotInvoked(currentRepo);
	// Show the indexing percentage on startup
	await reportIndexingPercentage(sidecarClient, currentRepo);

	// register the inline code completion provider
	await createInlineCompletionItemProvider(
		{
			triggerNotice: notice => {
				console.log(notice);
			},
			sidecarClient,
		}
	);
	// register the commands here for inline completion
	aideCommands();
	// set the status bar as well
	startupStatusBar();

	// Get the storage object here
	const codeStoryStorage = await loadOrSaveToStorage(context.globalStorageUri.fsPath, rootPath);
	logger.info(codeStoryStorage);
	logger.info(rootPath);


	// Register the semantic search command here
	commands.registerCommand('codestory.semanticSearch', async (prompt: string): Promise<CodeSymbolInformationEmbeddings[]> => {
		logger.info('[semanticSearch][extension] We are executing semantic search :' + prompt);
		postHogClient?.capture({
			distinctId: await getUniqueId(),
			event: 'search',
			properties: {
				prompt,
				repoName,
				repoHash,
			},
		});
		// We should be using the searchIndexCollection instead here, but for now
		// embedding search is fine
		// Here we will ping the semantic client instead so we can get the results
		const results = await sidecarClient.getSemanticSearchResult(
			prompt,
			currentRepo,
		);
		return results;
	});

	// Register the quick action providers
	const aideQuickFix = new AideQuickFix();
	languages.registerCodeActionsProvider('*', aideQuickFix);

	const chatAgentProvider = new CSChatAgentProvider(
		rootPath, repoName, repoHash,
		uniqueUserId,
		sidecarClient, currentRepo, projectContext
	);
	context.subscriptions.push(chatAgentProvider);

	const probeProvider = new AideProbeProvider(sidecarClient);
	context.subscriptions.push(probeProvider);

	// Register feedback commands
	context.subscriptions.push(
		commands.registerCommand('codestory.feedback', async () => {
			// Redirect to Discord server link
			await commands.executeCommand('vscode.open', 'https://discord.gg/FdKXRDGVuz');
		})
	);

	window.onDidChangeActiveTextEditor(async (editor) => {
		if (editor) {
			const activeDocument = editor.document;
			if (activeDocument) {
				const activeDocumentUri = activeDocument.uri;
				if (shouldTrackFile(activeDocumentUri)) {
					await sidecarClient.documentOpen(
						activeDocumentUri.fsPath,
						activeDocument.getText(),
						activeDocument.languageId
					);
				}
			}
		}
	});

	// Listen to all the files which are changing, so we can keep our tree sitter cache hot
	workspace.onDidChangeTextDocument(async (event) => {
		const documentUri = event.document.uri;
		// if its a schema type, then skip tracking it
		if (documentUri.scheme === 'vscode') {
			return;
		}
		// TODO(skcd): we want to send the file change event to the sidecar over here
		if (shouldTrackFile(documentUri)) {
			await sidecarClient.documentContentChange(
				documentUri.fsPath,
				event.contentChanges,
				event.document.getText(),
				event.document.languageId,
			);
		}
	});
}

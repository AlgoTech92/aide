/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { OpenAI } from 'openai';
import { EmbeddingsSearch } from '../../codeGraph/embeddingsSearch';
import { getCodeSymbolList } from '../../storage/indexer';
import { TSMorphProjectManagement, parseFileUsingTsMorph } from '../../utilities/parseTypescript';
import { CodeSymbolInformation, FileCodeSymbolInformation } from '../../utilities/types';
import { CodeModificationContextAndDiff, CodeSymbolModificationInstruction, NewFileContentAndDiffResponse, TextExecutionHarness, generateModifyCodeHallucinationPrompt, generateNewFileContentAndDiffResponseParser, generateTestExecutionPrompt, generateTestScriptGenerationPrompt, modifyCodeSnippetPrompt, newFileContentAndDiffPrompt, parseCodeModificationResponse, parseTestExecutionFinalSetupResponse, parseTestPlanResponseForHarness } from './prompts';
import { CodeGraph } from '../../codeGraph/graph';

import * as fs from 'fs';
import { generateChatCompletion } from './debugging';
import { ToolingEventCollection } from '../../timeline/events/collection';
import { runCommandAsync } from '../../utilities/commandRunner';
import { PythonServer } from '../../utilities/pythonServerClient';
import { ActiveFilesTracker } from '../../activeChanges/activeFilesTracker';
import { generateNewFileFromPatch } from '../../utilities/mergeModificationChangesToFile';
import { GoLangParser } from '../../languages/goCodeSymbols';
import { CodeSymbolsLanguageCollection } from '../../languages/codeSymbolsLanguageCollection';


export const getOpenFilesInWorkspace = (): string[] => {
	const openEditors = vscode.window.visibleTextEditors;

	// Filter out non-file editors (like output or debug console)
	const openFiles = openEditors
		.filter(editor => editor.document.uri.scheme === 'file')
		.map(editor => editor.document.uri.fsPath);

	// Display a message box to the user with open files
	return openFiles;
};


const formatFileInformationForPrompt = (
	fileCodeSymbolInformationList: FileCodeSymbolInformation
): string => {
	let prompt = `<file_path>${fileCodeSymbolInformationList.filePath}</file_path>\n`;
	fileCodeSymbolInformationList.codeSymbols.forEach((codeSymbol) => {
		prompt += `<code_symbol_name>${codeSymbol.symbolName}</code_symbol_name>\n`;
		// Now we need to split and add the code snippet here
		const splittedCodeSnippet = codeSymbol.codeSnippet.code.split('\n');
		prompt += '<snippet>\n';
		splittedCodeSnippet.forEach((codeSnippetLine) => {
			prompt += `${codeSnippetLine}\n`;
		});
		prompt += '</snippet>\n';
	});
	return prompt;
};

export const formatFileInformationListForPrompt = async (
	fileCodeSymbolInformationList: FileCodeSymbolInformation[]
): Promise<string> => {
	let relevantCodeSnippetPrompt = '<relevant_code_snippets_with_information>';
	for (let index = 0; index < fileCodeSymbolInformationList.length; index++) {
		relevantCodeSnippetPrompt +=
			formatFileInformationForPrompt(fileCodeSymbolInformationList[index]) + '\n';
	}
	relevantCodeSnippetPrompt += '</relevant_code_snippets_with_information>';
	return relevantCodeSnippetPrompt;
};


export const readFileContents = async (
	filePath: string,
): Promise<string> => {
	// Read the file from the location in the directory
	return fs.readFileSync(filePath, 'utf8');
};


export const writeFileContents = async (
	filePath: string,
	fileContent: string,
	isScratchFile: boolean = false,
): Promise<void> => {
	const resp = fs.writeFileSync(filePath, fileContent);

	if (!isScratchFile) {
		// Open the file in the editor
		await vscode.commands.executeCommand(
			'vscode.open',
			vscode.Uri.file(filePath),
		);

		// Call the git.refresh command to refresh the git status in the extension
		await vscode.commands.executeCommand('git.refresh');

		// Open the diff view for the file
		await vscode.commands.executeCommand(
			'git.openChange',
			vscode.Uri.file(filePath),
		);
	}

	return resp;
};


export const generateModificationInputForCodeSymbol = async (
	codeSymbolModificationInstruction: CodeSymbolModificationInstruction,
	previousMessages: OpenAI.Chat.CreateChatCompletionRequestMessage[],
	codeGraph: CodeGraph,
	uniqueId: string,
): Promise<CodeModificationContextAndDiff | null> => {
	const possibleCodeNodes = codeGraph.getNodeByLastName(
		codeSymbolModificationInstruction.codeSymbolName
	);
	if (!possibleCodeNodes) {
		console.log('We were unable to find possible code nodes');
		return null;
	}
	const codeSymbol = possibleCodeNodes[0];
	const fileCode = await readFileContents(codeSymbol.fsFilePath);

	// Now supporting big files for now, so we just return null here
	if (fileCode.split('\n').length > 2000) {
		console.log('File is too large to parse');
		return null;
	}

	const promptForModification = modifyCodeSnippetPrompt(
		fileCode,
		codeSymbol.codeSnippet.code,
		codeSymbolModificationInstruction.instructions,
		codeSymbol.fsFilePath,
	);

	const messages = [...previousMessages];
	messages.push(...generateModifyCodeHallucinationPrompt());
	messages.push(
		{
			content: promptForModification,
			role: 'user',
		}
	);

	const completion = await generateChatCompletion(
		messages,
		'generateModificationInputForCodeSymbol',
		uniqueId,
	);
	return parseCodeModificationResponse(completion?.message?.content ?? '');
};


export const generateModifiedFileContentAfterDiff = async (
	codeModificationInput: CodeSymbolModificationInstruction,
	modificationContext: CodeModificationContextAndDiff,
	codeGraph: CodeGraph,
	previousMessages: OpenAI.Chat.CreateChatCompletionRequestMessage[],
	uniqueId: string,
): Promise<NewFileContentAndDiffResponse | null> => {
	const possibleCodeNodes = codeGraph.getNodeByLastName(
		codeModificationInput.codeSymbolName
	);
	if (!possibleCodeNodes) {
		return null;
	}
	const codeSymbol = possibleCodeNodes[0];
	const fileCode = await readFileContents(codeSymbol.fsFilePath);
	// Now supporting big files for now, so we just return null here
	if (fileCode.split('\n').length > 2000) {
		return null;
	}

	const newFileContent = generateNewFileFromPatch(
		modificationContext.codeDiff,
		fileCode,
	);

	if (newFileContent) {
		console.log('[patchGeneratedFile] Generated file content with path no AI');
		console.log(newFileContent);
		return {
			newFileContent: newFileContent,
		};
	}

	const promptForModification = newFileContentAndDiffPrompt(
		codeSymbol.fsFilePath,
		fileCode,
		codeModificationInput.instructions,
		modificationContext.codeDiff,
		modificationContext.codeModification,
	);

	const messages = [...previousMessages];
	messages.push(...generateModifyCodeHallucinationPrompt());
	messages.push(
		{
			content: promptForModification,
			role: 'user',
		}
	);

	const completion = await generateChatCompletion(
		messages,
		'generateModifiedFileContentAfterDiff',
		uniqueId,
	);
	return generateNewFileContentAndDiffResponseParser(
		completion?.message?.content ?? '',
	);
};


export const getFilePathForCodeNode = (
	codeSymbolNameMaybe: string,
	codeGraph: CodeGraph,
): string | null => {
	console.log(`[getFilePathForCodeNode]: ${codeSymbolNameMaybe}`);
	const codeNodes = codeGraph.getNodeByLastName(codeSymbolNameMaybe);
	if (!codeNodes) {
		return null;
	}
	return codeNodes[0].fsFilePath;
};

const getCodeNodeForName = (
	codeSymbolNameMaybe: string,
	codeGraph: CodeGraph,
): CodeSymbolInformation | null => {
	const codeNodes = codeGraph.getNodeByLastName(codeSymbolNameMaybe);
	if (!codeNodes) {
		return null;
	}
	return codeNodes[0];
};

export const generateTestScriptForChange = async (
	codeSymbolNameMaybe: string,
	codeGraph: CodeGraph,
	codeModificationContext: CodeModificationContextAndDiff,
	previousMessages: OpenAI.Chat.CreateChatCompletionRequestMessage[],
	moduleName: string,
	previousFileContent: string,
	uniqueId: string,
): Promise<TextExecutionHarness | null> => {
	const codeNode = getCodeNodeForName(
		codeSymbolNameMaybe,
		codeGraph,
	);
	if (!codeNode) {
		return null;
	}
	const newFileContent = await readFileContents(codeNode.fsFilePath);
	const prompt = generateTestScriptGenerationPrompt(
		'jest',
		codeNode.fsFilePath,
		codeNode.symbolName,
		newFileContent,
		codeModificationContext.codeDiff,
		codeModificationContext.codeModification,
		moduleName,
	);
	const messages = [...previousMessages];
	messages.push({
		content: prompt,
		role: 'user',
	});
	const response = await generateChatCompletion(
		messages,
		'generateTestScriptForChange',
		uniqueId,
	);
	return parseTestPlanResponseForHarness(
		response?.message?.content ?? '',
		codeSymbolNameMaybe,
	);
};

export const stripPrefix = (input: string, prefix: string): string => {
	if (input.startsWith(prefix)) {
		return input.slice(prefix.length);
	}
	return input;
};


export const executeTestHarness = async (
	testPlan: TextExecutionHarness,
	previousMessages: OpenAI.Chat.CreateChatCompletionRequestMessage[],
	toolingEventCollection: ToolingEventCollection,
	executionEventId: string,
	codeSymbolNameMaybe: string,
	codeGraph: CodeGraph,
	codeSymbolsLanguageCollection: CodeSymbolsLanguageCollection,
	workingDirectory: string,
	uniqueId: string,
): Promise<number> => {
	const codeNode = getCodeNodeForName(
		codeSymbolNameMaybe,
		codeGraph,
	);
	if (!codeNode) {
		return 1;
	}

	return 0;
	// TODO(skcd): Fix this up properly
	// Early bail here if this is a python file
	// if (codeNode.fsFilePath.endsWith('.py')) {
	// 	return 0;
	// }

	// const project = tsMorphProjects.getTsMorphProjectForFile(codeNode.fsFilePath);
	// if (!project) {
	// 	return 1;
	// }

	// // We also need the new code symbol content so we are going to parse it
	// // from the file
	// const newCodeSymbolNodes = await parseFileUsingTsMorph(
	// 	codeNode.fsFilePath,
	// 	project,
	// 	workingDirectory,
	// 	codeNode.fsFilePath,
	// );

	// const newCodeSymbolNode = newCodeSymbolNodes.find((node) => {
	// 	// Here we have to match based on the last suffix of the code symbol
	// 	// when split by the dot
	// 	const splittedCodeSymbolName = node.symbolName.split('.').reverse();
	// 	let accumulator = '';
	// 	for (let index = 0; index < splittedCodeSymbolName.length; index++) {
	// 		const element = splittedCodeSymbolName[index];
	// 		if (index === 0) {
	// 			accumulator = element;
	// 		} else {
	// 			accumulator = `${element}.${accumulator}`;
	// 		}
	// 		if (accumulator === codeNode.symbolName) {
	// 			return true;
	// 		}
	// 	}
	// });

	// if (!newCodeSymbolNode) {
	// 	return 1;
	// }

	// const prompt = generateTestExecutionPrompt(
	// 	'jest',
	// 	testPlan.imports,
	// 	codeSymbolNameMaybe,
	// 	newCodeSymbolNode.codeSnippet.code,
	// 	testPlan.planForTestScriptGeneration,
	// 	testPlan.testScript,
	// );

	// const messages = [...previousMessages];
	// messages.push({
	// 	content: prompt,
	// 	role: 'user',
	// });
	// const response = await generateChatCompletion(
	// 	messages,
	// 	'executeTestHarness',
	// 	uniqueId,
	// );
	// const testSetupFinalResult = parseTestExecutionFinalSetupResponse(
	// 	response?.message?.content ?? '',
	// );

	// if (!testSetupFinalResult) {
	// 	return 1;
	// }

	// // Now we write to the file so we can test it out
	// await writeFileContents(
	// 	testPlan.testFileLocation,
	// 	testSetupFinalResult?.testScript ?? '',
	// );

	// console.log('Whats the test plan');
	// console.log(testPlan);
	// console.log('======');

	// // Send out the file save event
	// toolingEventCollection.saveFileEvent(
	// 	testPlan.testFileLocation,
	// 	codeSymbolNameMaybe,
	// 	executionEventId,
	// );

	// // Now we are going to execute the test harness here using 'jest' command
	// const { stdout, stderr, exitCode } = await runCommandAsync(
	// 	workingDirectory,
	// 	'jest',
	// 	[testPlan.testFileLocation],
	// );

	// // Now send a terminal event about this
	// toolingEventCollection.terminalEvent(
	// 	codeSymbolNameMaybe,
	// 	testPlan.testFileLocation,
	// 	stdout,
	// 	stderr,
	// 	exitCode,
	// 	['jest', testPlan.testFileLocation],
	// 	executionEventId,
	// );
	// return exitCode;
};


export const shouldExecuteTestHarness = (testRunCommand: string): boolean => {
	if (testRunCommand === 'NotPresent') {
		return false;
	}
	return true;
};

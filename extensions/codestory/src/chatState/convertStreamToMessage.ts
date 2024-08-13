/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { AgentStep, CodeSpan, ConversationMessage } from '../sidecar/types';
import { RepoRef, SideCarClient } from '../sidecar/client';
import { SideCarAgentEvent, SidecarRequestRange } from '../server/types';
import { Limiter } from '../server/applyEdits';
import { IndentationHelper, IndentStyleSpaces } from '../completions/providers/editorSessionProvider';
import { AdjustedLineContent, LineContent, LineIndentManager } from '../completions/providers/reportEditorSessionAnswerStream';
//import { addDecoration } from './decorations/add';


export const reportFromStreamToSearchProgress = async (
	stream: AsyncIterator<ConversationMessage>,
	response: vscode.AideChatResponseStream,
	cancellationToken: vscode.CancellationToken,
	workingDirectory: string,
): Promise<string> => {
	let finalMessage = '';
	if (cancellationToken.isCancellationRequested) {
		return '';
	}
	const firstPartOfMessage = async () => {
		const firstPart = await stream.next();
		if (firstPart.done) {
			return ''; // Handle when iterator is done
		}
		// TODO(skcd): Lets not log the session-id here
		// if we don't have the message id here that means this is an ack request so
		// we should just report that we are processing it on the backend
		// I know this ts-ignore is bad, but keeping it here for now
		// @ts-ignore
		// const sessionId = firstPart.value['session_id'];
		// return new CSChatProgressContent('Your session id is: ' + sessionId);
		return '';
	};

	const progress = await firstPartOfMessage();
	response.markdown(progress);

	// Now we are in the good state, we can start reporting the progress by looking
	// at the last step the agent has taken and reporting that to the chat
	if (cancellationToken.isCancellationRequested) {
		return finalMessage;
	}

	const asyncIterable = {
		[Symbol.asyncIterator]: () => stream
	};

	let enteredAnswerGenerationLoop = false;

	for await (const conversationMessage of asyncIterable) {
		// First we check if we have the answer, if that's the case then we know
		// we have what we want to repo

		// We have hit our done status, so lets skip it
		if ('done' in conversationMessage) {
			continue;
		}
		// Here we will get an event which will have the conversation_state as 'ReRankingStarted' and another
		// which will have an event as 'ReRankingFinished'
		if (conversationMessage.conversation_state === 'ReRankingStarted') {
			// console.log('ReRanking has started');
			continue;
		}
		if (conversationMessage.conversation_state === 'ReRankingFinished') {
			// console.log('ReRanking has finsihed');
			continue;
		}
		if (conversationMessage.answer !== null && conversationMessage.conversation_state === 'StreamingAnswer') {
			// We need to parse the answer a bit here, because we get relative paths
			// and not absolute paths. The right way to do this will be to attach
			// the reporef location to the message and that would solve a lot of
			// problems.
			if (!enteredAnswerGenerationLoop) {
				response.markdown('\n');
				// progress.report(new CSChatProgressContent('\n## Answer\n\n' + conversationMessage.answer.delta));
				enteredAnswerGenerationLoop = true;
			} else {
				// type-safety here, altho it its better to do it this way
				if (conversationMessage.answer.delta !== null) {
					response.markdown(conversationMessage.answer.delta);
				}
			}
		} else if (conversationMessage.answer !== null && conversationMessage.conversation_state === 'Finished') {
			finalMessage = conversationMessage.answer.answer_up_until_now;
			return finalMessage;
		}
		else {
			const stepsTaken = conversationMessage.steps_taken.length;
			const lastStep = conversationMessage.steps_taken[stepsTaken - 1];
			if ('Code' in lastStep) {
				reportCodeReferencesToChat(
					response,
					lastStep.Code.code_snippets,
					workingDirectory,
				);
			} else if ('Proc' in lastStep) {
				reportProcUpdateToChat(response, lastStep, workingDirectory);
			}
		}
	}

	return finalMessage;
};


export const formatPathsInAnswer = async (answer: string, reporef: RepoRef): Promise<string> => {
	async function isPathLike(markdownLink: string): Promise<boolean> {
		// Here the markdown link at the end of it might have #L{blah}-L{blah2},
		// we want to remove that part and then check if the path exists.
		const markdownLinkWithoutLineNumbers = markdownLink.split('#')[0];
		const finalPath = path.join(reporef.getPath(), markdownLinkWithoutLineNumbers);
		try {
			// console.log('[formatPathsInAnswer] checking the following path');
			// console.log(finalPath);
			await vscode.workspace.fs.stat(vscode.Uri.file(finalPath));
			return true;
		} catch (error) {
			return false;
		}
	}

	async function fullPathify(content: string, basePath: string): Promise<string> {
		// Regular expression to match markdown links.
		// This captures the link text and the link target separately.
		const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;

		let match;
		let lastIndex = 0;
		let resultString = '';

		while ((match = markdownLinkRegex.exec(content)) !== null) {
			// Add the previous unmatched text to the result
			resultString += content.slice(lastIndex, match.index);
			lastIndex = markdownLinkRegex.lastIndex;

			const [fullMatch, linkText, linkTarget] = match;

			if (await isPathLike(linkTarget)) {
				// If the link target looks like a path, replace it with the full path
				const fullPath = path.join(basePath, linkTarget);
				resultString += `[${linkText}](${fullPath})`;
			} else {
				// If not, add the original match
				resultString += fullMatch;
			}
		}

		// Add any remaining unmatched text to the result
		resultString += content.slice(lastIndex);

		return resultString;
	}

	return fullPathify(answer, reporef.getPath());
};


export const reportCodeSpansToChat = (codeSpans: CodeSpan[], workingDirectory: string): string => {
	// We limit it to 10 code spans.. and then show ... more or something here
	let suffixString = '';
	if (codeSpans.length > 5) {
		suffixString = '... and more code snippets\n\n';
	}
	const sortedCodeSpans = codeSpans.sort((a, b) => {
		if (a.score !== null && b.score !== null) {
			return b.score - a.score;
		}
		if (a.score !== null && b.score === null) {
			return -1;
		}
		if (a.score === null && b.score !== null) {
			return 1;
		}
		return 0;
	});
	let codeSpansString = '';
	for (let index = 0; index < Math.min(5, sortedCodeSpans.length); index++) {
		const currentCodeSpan = sortedCodeSpans[index];
		const fullFilePath = path.join(workingDirectory, currentCodeSpan.file_path);
		const currentFileLink = `${currentCodeSpan.file_path}#L${currentCodeSpan.start_line}-L${currentCodeSpan.end_line}`;
		const fileLink = `${fullFilePath}#L${currentCodeSpan.start_line}-L${currentCodeSpan.end_line}`;
		const markdownCodeSpan = `[${currentFileLink}](${fileLink})`;
		codeSpansString += markdownCodeSpan + '\n\n';
	}
	return '## Relevant code snippets\n\n' + codeSpansString + suffixString;
};

export const reportCodeReferencesToChat = (response: vscode.AideChatResponseStream, codeSpans: CodeSpan[], workingDirectory: string) => {
	const sortedCodeSpans = codeSpans.sort((a, b) => {
		if (a.score !== null && b.score !== null) {
			return b.score - a.score;
		}
		if (a.score !== null && b.score === null) {
			return -1;
		}
		if (a.score === null && b.score !== null) {
			return 1;
		}
		return 0;
	});
	for (let index = 0; index < Math.min(6, sortedCodeSpans.length); index++) {
		const currentCodeSpan = sortedCodeSpans[index];
		// console.log(workingDirectory);
		let fullFilePath = currentCodeSpan.file_path;
		if (!currentCodeSpan.file_path.startsWith(workingDirectory)) {
			fullFilePath = path.join(workingDirectory, currentCodeSpan.file_path);
		}
		response.reference(new vscode.Location(
			vscode.Uri.file(fullFilePath),
			new vscode.Range(
				new vscode.Position(currentCodeSpan.start_line, 0),
				new vscode.Position(currentCodeSpan.end_line, 0),
			),
		));
	}
};


export const reportProcUpdateToChat = (
	progress: vscode.AideChatResponseStream,
	proc: AgentStep,
	workingDirectory: string,
) => {
	if ('Proc' in proc) {
		const paths = proc.Proc.paths;
		for (let index = 0; index < Math.min(5, paths.length); index++) {
			const currentPath = paths[index];
			const fullFilePath = path.join(workingDirectory, currentPath);
			progress.reference(vscode.Uri.file(fullFilePath));
		}
	}
};

export const readJsonFile = (filePath: string): any => {
	const jsonString = fs.readFileSync(filePath, 'utf-8');
	return JSON.parse(jsonString);
};


// const randomInt = (min: number, max: number) =>
// 	Math.floor(Math.random() * (max - min + 1)) + min;

const pattern = /(?:^|\s)(\w+\s+at\s+[\w/.-]+)?(.*)/s;
export const reportAgentEventsToChat = async (
	editMode: boolean,
	stream: AsyncIterableIterator<SideCarAgentEvent>,
	response: vscode.ProbeResponseStream,
	threadId: string,
	token: vscode.CancellationToken,
	sidecarClient: SideCarClient,
	// we need to use a limiter here to make sure that the edits happen
	// one at a time and the stream does not close on the editor side since
	// we are sending async edits and they might go out of scope
	limiter: Limiter<any>,
): Promise<void> => {
	const editsMap = new Map();
	// console.log('reportAgentEventsToChat starting');
	const asyncIterable = {
		[Symbol.asyncIterator]: () => stream
	};

	// now we ping the sidecar that the probing needs to stop
	if (token.isCancellationRequested) {
		await sidecarClient.stopAgentProbe(threadId);
		return;
	}

	// Temp code: Create a new file to record logs
	// let logStream: fs.WriteStream | undefined;
	// const extensionRoot = vscode.extensions.getExtension('codestory-ghost.codestoryai')?.extensionPath;
	// const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
	// if (extensionRoot && workspaceRoot) {
	// 	const logPath = path.join(extensionRoot, 'src', 'completions', 'providers', 'dummydata.json');
	// 	logStream = fs.createWriteStream(logPath, { flags: 'w' });
	// }
	// logStream?.write('[');

	for await (const event of asyncIterable) {
		// await new Promise((resolve) => setTimeout(resolve, randomInt(0, 2) * 10));
		// now we ping the sidecar that the probing needs to stop
		if (token.isCancellationRequested) {
			await sidecarClient.stopAgentProbe(threadId);
			break;
		}

		if ('keep_alive' in event) {
			continue;
		}

		// logStream?.write(JSON.stringify(event) + ',\n');

		if (event.event.FrameworkEvent) {

			if (event.event.FrameworkEvent.InitialSearchSymbols) {
				const initialSearchSymbolInformation = event.event.FrameworkEvent.InitialSearchSymbols.symbols.map((item) => {
					return {
						symbolName: item.symbol_name,
						uri: vscode.Uri.file(item.fs_file_path),
						isNew: item.is_new,
						thinking: item.thinking,
					};
				});
				response.initialSearchSymbols(initialSearchSymbolInformation);
			} else if (event.event.FrameworkEvent.RepoMapGenerationStart) {
				response.repoMapGeneration(false);
			} else if (event.event.FrameworkEvent.RepoMapGenerationFinished) {
				response.repoMapGeneration(true);
			} else if (event.event.FrameworkEvent.LongContextSearchStart) {
				response.longContextSearch(false);
			} else if (event.event.FrameworkEvent.LongContextSearchFinished) {
				response.longContextSearch(true);
			} else if (event.event.FrameworkEvent.OpenFile) {
				const filePath = event.event.FrameworkEvent.OpenFile.fs_file_path;
				if (filePath) {
					response.openFile({
						uri: vscode.Uri.file(filePath),
					});
				}
			}
		} else if (event.event.SymbolEvent) {
			const symbolEvent = event.event.SymbolEvent.event;
			const symbolEventKeys = Object.keys(symbolEvent);
			if (symbolEventKeys.length === 0) {
				continue;
			}
			const symbolEventKey = symbolEventKeys[0] as keyof typeof symbolEvent;
			// If this is a symbol event then we have to make sure that we are getting the probe request over here
			if (!editMode && symbolEventKey === 'Probe' && symbolEvent.Probe !== undefined) {
				response.breakdown({
					reference: {
						uri: vscode.Uri.file(symbolEvent.Probe.symbol_identifier.fs_file_path ?? 'symbol_not_found'),
						name: symbolEvent.Probe.symbol_identifier.symbol_name,
					},
					query: new vscode.MarkdownString(symbolEvent.Probe.probe_request)
				});
			}
		} else if (event.event.SymbolEventSubStep) {
			const { symbol_identifier, event: symbolEventSubStep } = event.event.SymbolEventSubStep;
			if (!symbol_identifier.fs_file_path) {
				continue;
			}

			if (symbolEventSubStep.GoToDefinition) {
				const goToDefinition = symbolEventSubStep.GoToDefinition;
				const uri = vscode.Uri.file(goToDefinition.fs_file_path);
				const startPosition = new vscode.Position(goToDefinition.range.startPosition.line, goToDefinition.range.startPosition.character);
				const endPosition = new vscode.Position(goToDefinition.range.endPosition.line, goToDefinition.range.endPosition.character);
				const range = new vscode.Range(startPosition, endPosition);
				response.location({ uri, range, name: symbol_identifier.symbol_name, thinking: goToDefinition.thinking });
				continue;
			} else if (symbolEventSubStep.Edit) {
				const editEvent = symbolEventSubStep.Edit;
				if (editEvent.RangeSelectionForEdit) {
					response.breakdown({
						reference: {
							uri: vscode.Uri.file(symbol_identifier.fs_file_path),
							name: symbol_identifier.symbol_name
						}
					});
				} else if (editEvent.EditCodeStreaming) {
					// we have to do some state management over here
					// we send 3 distinct type of events over here
					// - start
					// - delta
					// - end
					const editStreamEvent = editEvent.EditCodeStreaming;
					const fileDocument = editStreamEvent.fs_file_path;
					const document = await vscode.workspace.openTextDocument(fileDocument);
					if (document === undefined || document === null) {
						continue;
					}
					const documentLines = document.getText().split(/\r\n|\r|\n/g);
					if ('Start' === editStreamEvent.event) {
						editsMap.set(editStreamEvent.edit_request_id, {
							answerSplitter: new AnswerSplitOnNewLineAccumulatorStreaming(),
							streamProcessor: new StreamProcessor(
								response,
								documentLines,
								undefined,
								vscode.Uri.file(editStreamEvent.fs_file_path),
								editStreamEvent.range,
								limiter,
							)
						});
					} else if ('End' === editStreamEvent.event) {
						// drain the lines which might be still present
						const editsManager = editsMap.get(editStreamEvent.edit_request_id);
						while (true) {
							const currentLine = editsManager.answerSplitter.getLine();
							if (currentLine === null) {
								break;
							}
							await editsManager.streamProcessor.processLine(currentLine);
						}
						// delete this from our map
						editsMap.delete(editStreamEvent.edit_request_id);
					} else if (editStreamEvent.event.Delta) {
						const editsManager = editsMap.get(editStreamEvent.edit_request_id);
						if (editsManager !== undefined) {
							editsManager.answerSplitter.addDelta(editStreamEvent.event.Delta);
							while (true) {
								const currentLine = editsManager.answerSplitter.getLine();
								if (currentLine === null) {
									break;
								}
								await editsManager.streamProcessor.processLine(currentLine);
							}
						}
					}
				}
			} else if (symbolEventSubStep.Probe) {
				const probeSubStep = symbolEventSubStep.Probe;
				const probeRequestKeys = Object.keys(probeSubStep) as (keyof typeof symbolEventSubStep.Probe)[];
				if (!symbol_identifier.fs_file_path || probeRequestKeys.length === 0) {
					continue;
				}

				const subStepType = probeRequestKeys[0];
				if (!editMode && subStepType === 'ProbeAnswer' && probeSubStep.ProbeAnswer !== undefined) {
					const probeAnswer = probeSubStep.ProbeAnswer;
					response.breakdown({
						reference: {
							uri: vscode.Uri.file(symbol_identifier.fs_file_path),
							name: symbol_identifier.symbol_name
						},
						response: new vscode.MarkdownString(probeAnswer)
					});
				}
			}
		} else if (event.event.RequestEvent) {
			const { ProbeFinished } = event.event.RequestEvent;
			if (!ProbeFinished) {
				continue;
			}

			const { reply } = ProbeFinished;
			if (reply === null) {
				continue;
			}

			// The sidecar currently sends '<symbolName> at <fileName>' at the start of the response. Remove it.
			const match = reply.match(pattern);
			if (match) {
				const suffix = match[2].trim();
				response.markdown(suffix);
			} else {
				response.markdown(reply);
			}

			break;
		} else if (event.event.EditRequestFinished) {
			break;
		}
	}

	//logStream?.write(']');
	//logStream?.end();
};


/**
 * Processor tools for making streaming edits a thing
 */
export enum AnswerStreamContext {
	BeforeCodeBlock,
	InCodeBlock,
	AfterCodeBlock,
}

export interface AnswerStreamLine {
	line: string;
	context: AnswerStreamContext;
}

export class AnswerSplitOnNewLineAccumulatorStreaming {
	accumulator: string;
	runningAnswer: string;
	lines: AnswerStreamLine[];
	codeBlockStringFound: boolean;
	runningState: AnswerStreamContext;

	constructor() {
		this.accumulator = '';
		this.runningAnswer = '';
		this.lines = [];
		this.codeBlockStringFound = false;
		this.runningState = AnswerStreamContext.BeforeCodeBlock;
	}

	addDelta(delta: string | null | undefined) {
		if (delta === null || delta === undefined) {
			return;
		}
		// When we are adding delta, we need to check if after adding the delta
		// we get a new line, and if we do we split it on the new line and add it
		// to our queue of events to push
		this.accumulator = this.accumulator + delta;
		while (true) {
			const newLineIndex = this.accumulator.indexOf('\n');
			// If we found no new line, lets just break here
			if (newLineIndex === -1) {
				break;
			}
			const completeLine = this.accumulator.substring(0, newLineIndex);
			if (/^```/.test(completeLine)) {
				if (!this.codeBlockStringFound) {
					this.codeBlockStringFound = true;
					this.runningState = AnswerStreamContext.BeforeCodeBlock;
				} else {
					this.runningState = AnswerStreamContext.InCodeBlock;
				}
			} else {
				if (this.codeBlockStringFound) {
					this.runningState = AnswerStreamContext.InCodeBlock;
				}
			}
			this.lines.push({
				line: completeLine,
				context: this.runningState,
			});
			// we set the accumulator to the remaining line
			this.accumulator = this.accumulator.substring(newLineIndex + 1);
		}
	}

	getLine(): AnswerStreamLine | null {
		if (this.lines.length === 0) {
			return null;
		}
		// or give back the first element of the string
		const line = this.lines[0];
		// remove the first element from the array
		this.lines = this.lines.slice(1);
		return line;
	}

	getLineLength(): number {
		return this.lines.length;
	}
}

export enum StateEnum {
	Initial,
	InitialAfterFilePath,
	InProgress,
}

class StreamProcessor {
	document: DocumentManager;
	currentState: StateEnum;
	previousLine: LineIndentManager | null;
	documentLineIndex: number;
	sentEdits: boolean;
	documentLineLimit: number;
	constructor(progress: vscode.ProbeResponseStream,
		lines: string[],
		indentStyle: IndentStyleSpaces | undefined,
		uri: vscode.Uri,
		range: SidecarRequestRange,
		limiter: Limiter<any>,
	) {
		// Initialize document with the given parameters
		this.document = new DocumentManager(
			progress,
			lines,
			range,
			indentStyle,
			uri,
			limiter,
		);
		this.documentLineLimit = Math.min(range.endPosition.line, this.document.getLineCount() - 1);

		// Set markers for file path, begin, and end
		this.currentState = StateEnum.InitialAfterFilePath;
		this.previousLine = null;
		this.documentLineIndex = this.document.firstSentLineIndex;
		this.sentEdits = false;
	}

	async processLine(answerStreamLine: AnswerStreamLine) {
		if (answerStreamLine.context !== AnswerStreamContext.InCodeBlock) {
			return;
		}
		const line = answerStreamLine.line;
		if (this.previousLine) {
			// if previous line is there, then we can reindent the current line
			// contents here
			const adjustedLine = this.previousLine.reindent(line, this.document.indentStyle);
			// find the anchor point for the current line
			// anchor will always be null over here
			const anchor = this.findAnchor(adjustedLine, this.documentLineIndex);
			if (anchor !== null) {
				this.sentEdits = true;
				// if no anchor line, then we have to replace the current line
				// console.log('replaceLines', this.documentLineIndex, anchor, adjustedLine);
				this.documentLineIndex = await this.document.replaceLines(this.documentLineIndex, anchor, adjustedLine);
			} else if (this.documentLineIndex >= this.documentLineLimit) {
				if (this.sentEdits) {
					this.documentLineIndex = await this.document.insertLineAfter(this.documentLineIndex - 1, adjustedLine);
					// this.documentLineIndex = await this.document.appendLine(adjustedLine);
				} else {
					if (this.documentLineIndex > this.documentLineLimit && !this.sentEdits) {
						this.documentLineIndex = await this.document.appendLine(adjustedLine);
					} else {
						this.documentLineIndex = await this.document.replaceLine(this.documentLineIndex, adjustedLine);
					}
				}
				this.sentEdits = true;
			} else {
				this.documentLineIndex = await this.document.replaceLine(this.documentLineIndex, adjustedLine);
				// we have sent the edits for this range, we should track that
			}
		} else {
			const initialAnchor = this.findInitialAnchor(line);
			this.previousLine = new LineIndentManager(this.document.getLine(initialAnchor).indentLevel, line);
			const adjustedInitialLine = this.previousLine.reindent(line, this.document.indentStyle);
			this.documentLineIndex = await this.document.replaceLine(initialAnchor, adjustedInitialLine);
		}
		console.log('documentLineIndex', this.documentLineIndex);
	}

	// Find the initial anchor line in the document
	findInitialAnchor(lineContent: string): number {
		const trimmedContent = lineContent.trim();
		for (let index = this.document.firstSentLineIndex; index < this.document.getLineCount(); index++) {
			const line = this.document.getLine(index);
			if (line.isSent && line.trimmedContent === trimmedContent) {
				return index;
			}
		}
		return this.document.firstRangeLine;
	}

	// Find the anchor line in the document based on indentation and content
	findAnchor(adjustedLine: AdjustedLineContent, startIndex: number): number | null {
		const endIndex = startIndex + 1;
		if (endIndex > 10000) {
			adjustedLine.adjustedContent = '';
		}
		return null;
	}
}


class DocumentManager {
	indentStyle: IndentStyleSpaces;
	progress: vscode.ProbeResponseStream;
	lines: LineContent[];
	firstSentLineIndex: number;
	firstRangeLine: number;
	uri: vscode.Uri;
	limiter: Limiter<any>;

	constructor(
		progress: vscode.ProbeResponseStream,
		lines: string[],
		// Fix the way we provide context over here?
		range: SidecarRequestRange,
		indentStyle: IndentStyleSpaces | undefined,
		uri: vscode.Uri,
		limiter: Limiter<any>,
	) {
		this.limiter = limiter;
		this.progress = progress; // Progress tracking
		this.lines = []; // Stores all the lines in the document
		this.indentStyle = IndentationHelper.getDocumentIndentStyle(lines, indentStyle);

		// Split the editor's text into lines and initialize each line
		const editorLines = lines;
		// restrict the document to the end position of the range, cause any code
		// after that is irrelevant to the current streaming edits
		for (let i = 0; i <= Math.min(Math.max(editorLines.length - 1, 0), range.endPosition.line); i++) {
			this.lines[i] = new LineContent(editorLines[i], this.indentStyle);
		}

		// Mark the lines as 'sent' based on the location provided
		const rangeLength = range.endPosition.line - range.startPosition.line + 1;
		const firstLineIndex = range.startPosition.line;
		for (let j = 0; j < rangeLength; j++) {
			const lineIndex = firstLineIndex + j;
			this.lines[lineIndex].markSent();
		}


		this.firstSentLineIndex = firstLineIndex;
		this.firstRangeLine = firstLineIndex;
		this.uri = uri;
	}

	// Returns the total number of lines
	getLineCount() {
		return this.lines.length;
	}

	// Retrieve a specific line
	getLine(index: number): LineContent {
		return this.lines[index];
	}

	// Replace a specific line and report the change
	async replaceLine(index: number, newLine: AdjustedLineContent) {
		this.lines[index] = new LineContent(newLine.adjustedContent, this.indentStyle);
		console.log('sidecar.replaceLine', index);
		const edits = new vscode.WorkspaceEdit();
		// console.log('What line are we replaceLine', newLine.adjustedContent);
		edits.replace(this.uri, new vscode.Range(index, 0, index, 1000), newLine.adjustedContent);
		await this.limiter.queue(async () => {
			await this.progress.codeEdit({ edits });
		});
		return index + 1;
	}

	// Replace multiple lines starting from a specific index
	async replaceLines(startIndex: number, endIndex: number, newLine: AdjustedLineContent) {
		console.log('sidecar.replaceLine', startIndex, endIndex);
		if (startIndex === endIndex) {
			return await this.replaceLine(startIndex, newLine);
		} else {
			this.lines.splice(
				startIndex,
				endIndex - startIndex + 1,
				new LineContent(newLine.adjustedContent, this.indentStyle)
			);
			const edits = new vscode.WorkspaceEdit();
			// console.log('sidecar.What line are we replaceLines', newLine.adjustedContent, startIndex, endIndex);
			edits.replace(this.uri, new vscode.Range(startIndex, 0, endIndex, 1000), newLine.adjustedContent);
			await this.limiter.queue(async () => {
				await this.progress.codeEdit({ edits });
			});
			return startIndex + 1;
		}
	}

	// Add a new line at the end
	async appendLine(newLine: AdjustedLineContent) {
		console.log('sidecar.appendLine', this.lines.length - 1);
		this.lines.push(new LineContent(newLine.adjustedContent, this.indentStyle));
		const edits = new vscode.WorkspaceEdit();
		// console.log('what line are we appendLine', newLine.adjustedContent);
		edits.replace(this.uri, new vscode.Range(this.lines.length - 2, 1000, this.lines.length - 2, 1000), '\n' + newLine.adjustedContent);
		await this.limiter.queue(async () => {
			await this.progress.codeEdit({ edits });
		});
		return this.lines.length;
	}

	// Insert a new line after a specific index
	async insertLineAfter(index: number, newLine: AdjustedLineContent) {
		console.log('insertLineAfter', index);
		this.lines.splice(index + 1, 0, new LineContent(newLine.adjustedContent, this.indentStyle));
		const edits = new vscode.WorkspaceEdit();
		// console.log('what line are we inserting insertLineAfter', newLine.adjustedContent);
		edits.replace(this.uri, new vscode.Range(index, 1000, index, 1000), '\n' + newLine.adjustedContent);
		await this.limiter.queue(async () => {
			await this.progress.codeEdit({ edits });
		});
		return index + 2;
	}
}

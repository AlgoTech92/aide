/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import OpenAI from 'openai';
import { Stream } from 'openai/streaming';
import { CSChatProgress, CSChatProgressTask, CSChatProgressContent, CSChatCancellationToken } from '../providers/chatprovider';
import { OpenAIChatTypes } from '@axflow/models/openai/chat';
import { StreamToIterable } from '@axflow/models/shared';

// Here we are going to convert the stream of messages to progress messages
// which we can report back on to the chat
export const reportFromStreamToProgress = async (
	streamPromise: Promise<Stream<OpenAI.Chat.Completions.ChatCompletionChunk> | null>,
	progress: vscode.Progress<CSChatProgress>,
	cancellationToken: CSChatCancellationToken,
): Promise<string> => {
	let finalMessage = '';
	const stream = await streamPromise;
	if (!stream) {
		return 'No reply from the LLM 🥲';
	}

	const streamIterator = stream[Symbol.asyncIterator]();

	if (cancellationToken.isCancellationRequested) {
		return finalMessage;
	}

	const firstPartOfMessage = async () => {
		const firstPart = await streamIterator.next();
		if (firstPart.done) {
			return new CSChatProgressContent(''); // Handle when iterator is done
		}
		finalMessage += firstPart.value.choices[0]?.delta?.content ?? '';
		return new CSChatProgressContent(firstPart.value.choices[0]?.delta?.content ?? '');
	};

	progress.report(new CSChatProgressTask(
		'Thinking... 🤔',
		firstPartOfMessage(),
	));

	if (cancellationToken.isCancellationRequested) {
		return finalMessage;
	}

	const asyncIterable = {
		[Symbol.asyncIterator]: () => streamIterator
	};

	for await (const part of asyncIterable) {
		finalMessage += part.choices[0]?.delta?.content ?? '';
		if (cancellationToken.isCancellationRequested) {
			return finalMessage;
		}
		progress.report(new CSChatProgressContent(part.choices[0]?.delta?.content ?? ''));
	}

	return finalMessage;
};


export const reportFromStreamToProgressAx = async (
	streamPromise: Promise<ReadableStream<string> | null>,
	progress: vscode.Progress<CSChatProgress>,
	cancellationToken: CSChatCancellationToken,
): Promise<string> => {
	let finalMessage = '';
	const stream = await streamPromise;
	if (!stream) {
		return 'No reply from the LLM 🥲';
	}

	if (cancellationToken.isCancellationRequested) {
		return finalMessage;
	}

	const reader = stream.getReader();

	const firstPartOfMessage = async () => {
		const firstPart = await reader.read();
		if (firstPart.done) {
			reader.releaseLock();
			return new CSChatProgressContent(''); // Handle when iterator is done
		}
		reader.releaseLock();
		finalMessage += firstPart.value ?? '';
		return new CSChatProgressContent(firstPart.value ?? '');
	};

	// This polls the firstPartOfMessage() function and when its finished,
	// we move on to the next bits.
	progress.report(new CSChatProgressTask(
		'Thinking... 🤔',
		firstPartOfMessage(),
	));

	if (cancellationToken.isCancellationRequested) {
		return finalMessage;
	}

	for await (const part of StreamToIterable(stream)) {
		finalMessage += part ?? '';
		if (cancellationToken.isCancellationRequested) {
			return finalMessage;
		}
		progress.report(new CSChatProgressContent(part ?? ''));
	}

	return finalMessage;
};

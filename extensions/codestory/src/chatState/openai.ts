/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAI } from 'openai';
import { Stream } from 'openai/streaming';
import { getOpenAIApiKey } from '../utilities/getOpenAIKey';

const openai = new OpenAI({
	apiKey: getOpenAIApiKey(),
});

export const generateChatCompletion = async (
	messages: OpenAI.Chat.CreateChatCompletionRequestMessage[]
): Promise<Stream<OpenAI.Chat.Completions.ChatCompletionChunk> | null> => {
	const completion: Stream<OpenAI.Chat.Completions.ChatCompletionChunk> = await openai.chat.completions.create({
		model: 'gpt-4',
		messages: messages,
		max_tokens: 1000,
		stream: true,
	});
	return completion;
};

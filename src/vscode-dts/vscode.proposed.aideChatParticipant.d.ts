/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	/**
	 * The location at which the chat is happening.
	 */
	export enum AideChatLocation {
		/**
		 * The chat panel
		 */
		Panel = 1,
		/**
		 * Terminal inline chat
		 */
		Terminal = 2,
		/**
		 * Notebook inline chat
		 */
		Notebook = 3,
		/**
		 * Code editor inline chat
		 */
		Editor = 4
	}

	export interface AideChatWelcomeMessageProvider {
		provideWelcomeMessage(location: AideChatLocation, token: CancellationToken): ProviderResult<ChatWelcomeMessageContent[]>;
		provideSampleQuestions?(location: AideChatLocation, token: CancellationToken): ProviderResult<ChatFollowup[]>;
	}

	export interface AideChatParticipant extends Omit<ChatParticipant, 'requestHandler' | 'welcomeMessageProvider' | 'onDidReceiveFeedback'> {
		/**
		 * The handler for requests to this participant.
		 */
		requestHandler: AideChatExtendedRequestHandler;

		/**
		 * The welcome message provider for this participant.
		 */
		welcomeMessageProvider?: AideChatWelcomeMessageProvider;

		/**
		 * An event that fires whenever feedback for a result is received, e.g. when a user up- or down-votes
		 * a result.
		 *
		 * The passed {@link ChatResultFeedback.result result} is guaranteed to be the same instance that was
		 * previously returned from this chat participant.
		 */
		onDidReceiveFeedback: Event<AideChatResultFeedback>;
	}

	export interface AideChatRequest extends Omit<ChatRequest, 'location'> {
		readonly threadId: string;

		/**
		 * The location at which the chat is happening. This will always be one of the supported values
		 */
		readonly location: AideChatLocation;
	}

	interface CodeReferenceByName {
		readonly name: string;
		readonly uri: Uri;
	}

	export interface AideChatResponseBreakdown {
		/**
		 * Code reference relevant to this breakdown.
		 */
		readonly reference: CodeReferenceByName;

		/**
		 * The query made to AI for this breakdown.
		 */
		readonly query?: MarkdownString;

		/**
		 * The reason this query was made.
		 */
		readonly reason?: MarkdownString;

		/**
		 * The response from AI for this breakdown.
		 */
		readonly response?: MarkdownString;
	}

	export interface AideProbeResponseOpenFile {
		/**
		 * The file where the agent went to the definition.
		 */
		readonly uri: Uri;
	}


	export interface AideChatResponseTextEdit {
		/**
		 * The file where the agent went to the definition.
		 */
		readonly uri: Uri;

		/**
		 * Edits applied to the document
		 */
		readonly edits: TextEdit[];
	}

	export interface AideChatResponseStream extends ChatResponseStream {
	}

	export type AideChatExtendedRequestHandler = (request: AideChatRequest, context: ChatContext, response: AideChatResponseStream, token: CancellationToken) => ProviderResult<ChatResult | void>;

	/**
	 * Represents the type of user feedback received.
	 */
	export enum AideChatResultFeedbackKind {
		/**
		 * The user marked the result as unhelpful.
		 */
		Unhelpful = 0,

		/**
		 * The user marked the result as helpful.
		 */
		Helpful = 1,
	}

	export interface AideChatResultFeedback {
		/**
		 * The ChatResult for which the user is providing feedback.
		 * This object has the same properties as the result returned from the participant callback, including `metadata`, but is not the same instance.
		 */
		readonly result: ChatResult;

		/**
		 * The kind of feedback that was received.
		 */
		readonly kind: AideChatResultFeedbackKind;
	}

	export namespace aideChat {
		/**
		 * Current version of the proposal. Changes whenever backwards-incompatible changes are made.
		 * If a new feature is added that doesn't break existing code, the version is not incremented. When the extension uses this new feature, it should set its engines.vscode version appropriately.
		 * But if a change is made to an existing feature that would break existing code, the version should be incremented.
		 * The chat extension should not activate if it doesn't support the current version.
		 */
		export const _version: 1 | number;

		/**
		 * Create a chat participant with the extended progress type
		 */
		export function createChatParticipant(id: string, handler: AideChatExtendedRequestHandler): AideChatParticipant;

		export function createDynamicChatParticipant(id: string, dynamicProps: DynamicChatParticipantProps, handler: AideChatExtendedRequestHandler): AideChatParticipant;
	}
}

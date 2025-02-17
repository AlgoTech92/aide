/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { revive } from '../../../../base/common/marshalling.js';
import { URI } from '../../../../base/common/uri.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { asCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { ContentRefData, contentRefUrl } from '../common/annotations.js';
import { getFullyQualifiedId, IChatAgentCommand, IChatAgentData, IAideAgentAgentNameService, IAideAgentAgentService } from '../common/aideAgentAgents.js';
import { chatSlashCommandBackground, chatSlashCommandForeground } from '../common/aideAgentColors.js';
import { chatAgentLeader, ChatRequestAgentPart, ChatRequestAgentSubcommandPart, ChatRequestDynamicVariablePart, ChatRequestSlashCommandPart, ChatRequestTextPart, ChatRequestToolPart, ChatRequestVariablePart, chatSubcommandLeader, IParsedChatRequest, IParsedChatRequestPart } from '../common/aideAgentParserTypes.js';
import { IAideAgentService } from '../common/aideAgentService.js';
import { IAideAgentVariablesService } from '../common/aideAgentVariables.js';
import { IAideAgentLMToolsService } from '../common/languageModelToolsService.js';
import { IAideAgentWidgetService } from './aideAgent.js';
import { InlineAnchorWidget } from './aideAgentInlineAnchorWidget.js';
import './media/aideAgentInlineAnchorWidget.css';

/** For rendering slash commands, variables */
const decorationRefUrl = `http://_vscodedecoration_`;

/** For rendering agent decorations with hover */
const agentRefUrl = `http://_chatagent_`;

/** For rendering agent decorations with hover */
const agentSlashRefUrl = `http://_chatslash_`;

export function agentToMarkdown(agent: IChatAgentData, isClickable: boolean, accessor: ServicesAccessor): string {
	const chatAgentNameService = accessor.get(IAideAgentAgentNameService);
	const chatAgentService = accessor.get(IAideAgentAgentService);

	const isAllowed = chatAgentNameService.getAgentNameRestriction(agent);
	let name = `${isAllowed ? agent.name : getFullyQualifiedId(agent)}`;
	const isDupe = isAllowed && chatAgentService.agentHasDupeName(agent.id);
	if (isDupe) {
		name += ` (${agent.publisherDisplayName})`;
	}

	const args: IAgentWidgetArgs = { agentId: agent.id, name, isClickable };
	return `[${agent.name}](${agentRefUrl}?${encodeURIComponent(JSON.stringify(args))})`;
}

interface IAgentWidgetArgs {
	agentId: string;
	name: string;
	isClickable?: boolean;
}

export function agentSlashCommandToMarkdown(agent: IChatAgentData, command: IChatAgentCommand): string {
	const text = `${chatSubcommandLeader}${command.name}`;
	const args: ISlashCommandWidgetArgs = { agentId: agent.id, command: command.name };
	return `[${text}](${agentSlashRefUrl}?${encodeURIComponent(JSON.stringify(args))})`;
}

interface ISlashCommandWidgetArgs {
	agentId: string;
	command: string;
}

interface IDecorationWidgetArgs {
	title?: string;
}

export class ChatMarkdownDecorationsRenderer extends Disposable {

	constructor(
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ILogService private readonly logService: ILogService,
		@IAideAgentAgentService private readonly chatAgentService: IAideAgentAgentService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IHoverService private readonly hoverService: IHoverService,
		@IAideAgentService private readonly chatService: IAideAgentService,
		@IAideAgentWidgetService private readonly chatWidgetService: IAideAgentWidgetService,
		@IAideAgentVariablesService private readonly chatVariablesService: IAideAgentVariablesService,
		@ILabelService private readonly labelService: ILabelService,
		@IAideAgentLMToolsService private readonly toolsService: IAideAgentLMToolsService,
	) {
		super();
	}

	convertParsedRequestToMarkdown(parsedRequest: IParsedChatRequest): string {
		let result = '';
		for (const part of parsedRequest.parts) {
			if (part instanceof ChatRequestTextPart) {
				result += part.text;
			} else if (part instanceof ChatRequestAgentPart) {
				result += this.instantiationService.invokeFunction(accessor => agentToMarkdown(part.agent, false, accessor));
			} else {
				result += this.genericDecorationToMarkdown(part);
			}
		}

		return result;
	}

	private genericDecorationToMarkdown(part: IParsedChatRequestPart): string {
		const uri = part instanceof ChatRequestDynamicVariablePart && part.data instanceof URI ?
			part.data :
			undefined;
		const title = uri ? this.labelService.getUriLabel(uri, { relative: true }) :
			part instanceof ChatRequestSlashCommandPart ? part.slashCommand.detail :
				part instanceof ChatRequestAgentSubcommandPart ? part.command.description :
					part instanceof ChatRequestVariablePart ? (this.chatVariablesService.getVariable(part.variableName)?.description) :
						part instanceof ChatRequestToolPart ? (this.toolsService.getTool(part.toolId)?.userDescription) :
							'';

		const args: IDecorationWidgetArgs = { title };
		const text = part.text;
		return `[${text}](${decorationRefUrl}?${encodeURIComponent(JSON.stringify(args))})`;
	}

	walkTreeAndAnnotateReferenceLinks(element: HTMLElement): IDisposable {
		const store = new DisposableStore();
		element.querySelectorAll('a').forEach(a => {
			const href = a.getAttribute('data-href');
			if (href) {
				if (href.startsWith(agentRefUrl)) {
					let args: IAgentWidgetArgs | undefined;
					try {
						args = JSON.parse(decodeURIComponent(href.slice(agentRefUrl.length + 1)));
					} catch (e) {
						this.logService.error('Invalid chat widget render data JSON', toErrorMessage(e));
					}

					if (args) {
						a.parentElement!.replaceChild(
							this.renderAgentWidget(args, store),
							a);
					}
				} else if (href.startsWith(agentSlashRefUrl)) {
					let args: ISlashCommandWidgetArgs | undefined;
					try {
						args = JSON.parse(decodeURIComponent(href.slice(agentRefUrl.length + 1)));
					} catch (e) {
						this.logService.error('Invalid chat slash command render data JSON', toErrorMessage(e));
					}

					if (args) {
						a.parentElement!.replaceChild(
							this.renderSlashCommandWidget(a.textContent!, args, store),
							a);
					}
				} else if (href.startsWith(decorationRefUrl)) {
					let args: IDecorationWidgetArgs | undefined;
					try {
						args = JSON.parse(decodeURIComponent(href.slice(decorationRefUrl.length + 1)));
					} catch (e) { }

					a.parentElement!.replaceChild(
						this.renderResourceWidget(a.textContent!, args, store),
						a);
				} else if (href.startsWith(contentRefUrl)) {
					this.renderFileWidget(href, a, store);
				} else if (href.startsWith('command:')) {
					this.injectKeybindingHint(a, href, this.keybindingService);
				}
			}
		});

		return store;
	}

	private renderAgentWidget(args: IAgentWidgetArgs, store: DisposableStore): HTMLElement {
		const nameWithLeader = `${chatAgentLeader}${args.name}`;
		let container: HTMLElement;
		if (args.isClickable) {
			container = dom.$('span.chat-agent-widget');
			const button = store.add(new Button(container, {
				buttonBackground: asCssVariable(chatSlashCommandBackground),
				buttonForeground: asCssVariable(chatSlashCommandForeground),
				buttonHoverBackground: undefined
			}));
			button.label = nameWithLeader;
			store.add(button.onDidClick(() => {
				const agent = this.chatAgentService.getAgent(args.agentId);
				const widget = this.chatWidgetService.lastFocusedWidget;
				if (!widget || !agent) {
					return;
				}

				this.chatService.sendRequest(widget.viewModel!.sessionId, agent.metadata.sampleRequest ?? '', { location: widget.location, agentId: agent.id });
			}));
		} else {
			container = this.renderResourceWidget(nameWithLeader, undefined, store);
		}

		return container;
	}

	private renderSlashCommandWidget(name: string, args: ISlashCommandWidgetArgs, store: DisposableStore): HTMLElement {
		const container = dom.$('span.chat-agent-widget.chat-command-widget');
		const agent = this.chatAgentService.getAgent(args.agentId);
		const button = store.add(new Button(container, {
			buttonBackground: asCssVariable(chatSlashCommandBackground),
			buttonForeground: asCssVariable(chatSlashCommandForeground),
			buttonHoverBackground: undefined
		}));
		button.label = name;
		store.add(button.onDidClick(() => {
			const widget = this.chatWidgetService.lastFocusedWidget;
			if (!widget || !agent) {
				return;
			}

			const command = agent.slashCommands.find(c => c.name === args.command);
			this.chatService.sendRequest(widget.viewModel!.sessionId, command?.sampleRequest ?? '', { location: widget.location, agentId: agent.id, slashCommand: args.command });
		}));

		return container;
	}

	private renderFileWidget(href: string, a: HTMLAnchorElement, store: DisposableStore): void {
		// TODO this can be a nicer FileLabel widget with an icon. Do a simple link for now.
		const fullUri = URI.parse(href);
		let data: ContentRefData;
		try {
			data = revive(JSON.parse(fullUri.fragment));
		} catch (err) {
			this.logService.error('Invalid chat widget render data JSON', toErrorMessage(err));
			return;
		}

		if (data.kind !== 'symbol' && !URI.isUri(data.uri)) {
			this.logService.error(`Invalid chat widget render data: ${fullUri.fragment}`);
			return;
		}

		store.add(this.instantiationService.createInstance(InlineAnchorWidget, a, data));
	}

	private renderResourceWidget(name: string, args: IDecorationWidgetArgs | undefined, store: DisposableStore): HTMLElement {
		const container = dom.$('span.chat-resource-widget');
		const alias = dom.$('span', undefined, name);
		if (args?.title) {
			store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, args.title));
		}

		container.appendChild(alias);
		return container;
	}


	private injectKeybindingHint(a: HTMLAnchorElement, href: string, keybindingService: IKeybindingService): void {
		const command = href.match(/command:([^\)]+)/)?.[1];
		if (command) {
			const kb = keybindingService.lookupKeybinding(command);
			if (kb) {
				const keybinding = kb.getLabel();
				if (keybinding) {
					a.textContent = `${a.textContent} (${keybinding})`;
				}
			}
		}
	}
}

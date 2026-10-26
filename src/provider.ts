import { createOpenAI } from "@ai-sdk/openai";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { getChatGPTAccessToken } from "./auth.js";
import { apiError, apiErrorCode, ChatGPTError, isObject } from "./errors.js";

const UNSUPPORTED_FIELDS = [
	"background",
	"conversation",
	"max_output_tokens",
	"max_tool_calls",
	"metadata",
	"moderation",
	"multi_agent",
	"previous_response_id",
	"prompt",
	"prompt_cache_retention",
	"safety_identifier",
	"service_tier",
	"temperature",
	"top_logprobs",
	"top_p",
	"truncation",
	"user",
];

const ALLOWED_TOOL_TYPES = new Set(["function", "custom", "namespace", "web_search", "web_search_preview"]);
const UNSUPPORTED_INPUT_TYPES = new Set(["input_audio", "input_video", "audio", "video"]);
const NON_RETRYABLE_API_CODES = new Set([
	"subscription_sharing_user_not_eligible",
	"subscription_sharing_usage_limit_exceeded",
	"subscription_sharing_unsupported_capability",
	"subscription_sharing_route_not_supported",
	"subscription_sharing_invalid_user",
	"chatpass_v2_scope_not_authorized",
	"chatpass_v2_invalid_authorization_context",
	"invalid_api_key",
	"invalid_token",
	"model_not_found",
]);

export interface ChatGPTProviderOptions {
	authPath?: string;
	fetch?: typeof fetch;
	groupTools?: boolean | string;
	refreshOnUnauthorized?: boolean;
}

function textOf(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	return partsOf(value)
		.filter((part): part is { type: string; text: string } => {
			const candidate = part as { type?: unknown; text?: unknown };
			return (
				isObject(part) &&
				(candidate.type === "text" || candidate.type === "input_text") &&
				typeof candidate.text === "string"
			);
		})
		.map((part) => part.text)
		.join("");
}

function isSystemMessage(value: unknown): boolean {
	return isObject(value) && value.role === "system";
}

function invalidInput(message: string): ChatGPTError {
	return new ChatGPTError("invalid_input", message);
}

function validateMedia(part: Record<string, unknown>): void {
	if (typeof part.type === "string" && UNSUPPORTED_INPUT_TYPES.has(part.type)) {
		throw new ChatGPTError("unsupported_input", "ChatGPT plan usage does not support audio or video input.");
	}

	if ((part.type === "input_file" || part.type === "input_image") && typeof part.file_id === "string") {
		throw new ChatGPTError(
			"unsupported_input",
			"ChatGPT plan usage does not support the Files API. Use an inline file or URL instead.",
		);
	}
}

function partsOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function validateInput(input: unknown[]): void {
	for (const item of input) {
		if (!isObject(item)) {
			throw invalidInput("ChatGPT requires input items to be objects.");
		}

		validateMedia(item);

		if (item.type === "additional_tools" && Array.isArray(item.tools)) {
			validateTools(item.tools);
		}

		for (const part of [...partsOf(item.content), ...partsOf(item.output)]) {
			if (isObject(part)) {
				validateMedia(part);
			}
		}
	}
}

function validateTools(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) {
		throw new ChatGPTError("invalid_tools", "ChatGPT requires tools to be an array.");
	}

	const tools: Array<Record<string, unknown>> = [];

	for (const tool of value) {
		if (!isObject(tool) || typeof tool.type !== "string") {
			throw new ChatGPTError("invalid_tools", "ChatGPT requires each tool to have a type.");
		}

		if (!ALLOWED_TOOL_TYPES.has(tool.type)) {
			throw new ChatGPTError(
				"unsupported_tool",
				`The "${tool.type}" tool is not supported by ChatGPT plan usage. Use function, custom, namespace, or web search tools.`,
			);
		}

		if (tool.type === "namespace") {
			if (typeof tool.name !== "string" || !Array.isArray(tool.tools)) {
				throw new ChatGPTError("invalid_tools", "ChatGPT tool namespaces require a name and tools array.");
			}

			for (const child of tool.tools) {
				if (!isObject(child) || (child.type !== "function" && child.type !== "custom")) {
					throw new ChatGPTError(
						"unsupported_tool",
						"ChatGPT tool namespaces may only contain function or custom tools.",
					);
				}
			}
		}

		tools.push(tool);
	}

	return tools;
}

function groupTools(
	tools: Array<Record<string, unknown>>,
	option: boolean | string,
	toolChoice: unknown,
): Array<Record<string, unknown>> {
	if (option === false) {
		return tools;
	}

	const name = typeof option === "string" ? option : "tools";

	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
		throw new ChatGPTError("invalid_group_tools", "The tool namespace name must contain only letters, numbers, _ or -.");
	}

	const groupable = tools.filter((tool) => tool.type === "function" || tool.type === "custom");

	if (groupable.length === 0) {
		return tools;
	}

	if (isObject(toolChoice)) {
		throw new ChatGPTError(
			"unsupported_tool_choice",
			"groupTools cannot be combined with a named tool_choice. Use auto, required, or none, or disable groupTools.",
		);
	}

	const rest: Array<Record<string, unknown>> = [];

	for (const tool of tools) {
		if (tool.type === "namespace") {
			rest.push({
				...tool,
				tools: [...(tool.tools as Array<Record<string, unknown>>)],
			});
		} else if (tool.type !== "function" && tool.type !== "custom") {
			rest.push(tool);
		}
	}

	const existing = rest.find((tool) => tool.type === "namespace" && tool.name === name);

	if (existing) {
		existing.tools = [...(existing.tools as Array<Record<string, unknown>>), ...groupable];
	} else {
		rest.unshift({
			type: "namespace",
			name,
			description: "Tools provided by the application.",
			tools: groupable,
		});
	}

	return rest;
}

export function transformChatGPTRequest(
	input: Record<string, unknown>,
	groupToolsOption: boolean | string = true,
): Record<string, unknown> {
	const body = { ...input };
	body.store = false;
	body.stream = true;

	for (const field of UNSUPPORTED_FIELDS) {
		if ((field === "conversation" || field === "previous_response_id") && body[field] !== undefined) {
			throw new ChatGPTError(
				"unsupported_option",
				`ChatGPT plan usage does not support ${field}. Send the full conversation history in input instead.`,
			);
		}

		delete body[field];
	}

	if (typeof body.input === "string") {
		body.input = [{ role: "user", content: body.input }];
	}

	if (!Array.isArray(body.input)) {
		throw invalidInput("ChatGPT requires input as an array of messages.");
	}

	validateInput(body.input);
	const system = body.input
		.filter(isSystemMessage)
		.map((message) => textOf(message.content))
		.filter(Boolean)
		.join("\n\n");
	body.input = body.input.filter((message) => !isSystemMessage(message));

	if (system) {
		const instructions = typeof body.instructions === "string" ? body.instructions : textOf(body.instructions);
		body.instructions = [instructions, system].filter(Boolean).join("\n\n");
	}

	if (body.tools !== undefined && body.tools !== null) {
		const tools = validateTools(body.tools);
		body.tools = groupTools(tools, groupToolsOption, body.tool_choice);
	} else if (body.tools === null) {
		delete body.tools;
	}

	if (body.reasoning !== undefined && body.reasoning !== null) {
		const include = Array.isArray(body.include)
			? body.include.filter((value): value is string => typeof value === "string")
			: [];

		if (!include.includes("reasoning.encrypted_content")) {
			body.include = [...include, "reasoning.encrypted_content"];
		}
	}

	return body;
}

function parseSseEvent(block: string): Record<string, unknown> | undefined {
	const data = block
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n");

	if (!data || data === "[DONE]") {
		return undefined;
	}

	try {
		const value = JSON.parse(data) as unknown;
		return isObject(value) ? value : undefined;
	} catch (error) {
		throw new ChatGPTError("invalid_stream", "ChatGPT returned an invalid response stream.", { cause: error, retryable: true });
	}
}

async function bufferResponsesStream(response: Response): Promise<Response> {
	const text = await response.text();

	if (text.length > 64 * 1024 * 1024) {
		throw new ChatGPTError("response_too_large", "ChatGPT returned a response that is too large.", { retryable: false });
	}

	const requestId = response.headers.get("openai-request-id") ?? response.headers.get("x-request-id") ?? undefined;
	let completed: Record<string, unknown> | undefined;
	let sawEvent = false;

	for (const block of text.split(/\r?\n\r?\n/)) {
		const event = parseSseEvent(block);

		if (!event) {
			continue;
		}

		sawEvent = true;

		if (event.type === "response.completed") {
			completed = isObject(event.response) ? event.response : undefined;
			continue;
		}

		if (event.type === "response.failed") {
			throw apiError(isObject(event.response) ? event.response.error : event, 400, requestId);
		}

		if (event.type === "response.incomplete") {
			throw new ChatGPTError("response_incomplete", "ChatGPT stopped before completing the response.", {
				retryable: true,
				requestId,
			});
		}

		if (event.type === "error") {
			throw apiError(event.error ?? event, 400, requestId);
		}
	}

	if (!completed) {
		if (!sawEvent) {
			let value: unknown;

			try {
				value = JSON.parse(text);
			} catch {
				value = undefined;
			}

			if (isObject(value)) {
				const headers = new Headers(response.headers);
				headers.delete("content-encoding");
				headers.delete("content-length");
				headers.set("content-type", "application/json");
				return new Response(JSON.stringify(value), { status: response.status, headers });
			}
		}

		throw new ChatGPTError("stream_interrupted", "ChatGPT ended the stream before response.completed.", {
			retryable: true,
			requestId,
		});
	}

	const headers = new Headers(response.headers);
	headers.delete("content-encoding");
	headers.delete("content-length");
	headers.set("content-type", "application/json");

	if (requestId) {
		headers.set("openai-request-id", requestId);
		headers.set("x-request-id", requestId);
	}

	return new Response(JSON.stringify(completed), { status: 200, headers });
}

function createFetch(options: ChatGPTProviderOptions): FetchFunction {
	const inner = options.fetch ?? fetch;
	const groupToolsOption = options.groupTools ?? true;

	async function stopNonRetryable(response: Response): Promise<void> {
		if (response.ok || response.status === 503) {
			return;
		}

		const body = await response.clone().json().catch(() => undefined);
		const code = apiErrorCode(body);

		if (!code || !NON_RETRYABLE_API_CODES.has(code)) {
			return;
		}

		await response.body?.cancel().catch(() => undefined);
		throw apiError(
			body,
			response.status,
			response.headers.get("openai-request-id") ?? response.headers.get("x-request-id"),
		);
	}

	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		let endpoint: URL;

		try {
			endpoint = new URL(url);
		} catch {
			throw new ChatGPTError("unsupported_route", "ChatGPT plan usage requires an absolute Responses API URL.");
		}

		if (endpoint.origin !== "https://api.openai.com" || endpoint.pathname !== "/v1/responses") {
			throw new ChatGPTError(
				"unsupported_route",
				"ChatGPT plan usage only supports POST https://api.openai.com/v1/responses. Use the provider as a function or call provider.responses().",
			);
		}

		const baseHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		baseHeaders.delete("openai-organization");
		baseHeaders.delete("openai-project");
		baseHeaders.delete("organization");
		baseHeaders.delete("project");
		let body = init?.body;
		let bufferStream = false;

		if (typeof body === "string") {
			let request: Record<string, unknown>;

			try {
				request = JSON.parse(body) as Record<string, unknown>;
			} catch (error) {
				throw new ChatGPTError("invalid_request", "ChatGPT request body was not valid JSON.", { cause: error });
			}

			bufferStream = request.stream !== true;
			body = JSON.stringify(transformChatGPTRequest(request, groupToolsOption));
		}

		const send = async (accessToken: string) => {
			const headers = new Headers(baseHeaders);
			headers.set("authorization", `Bearer ${accessToken}`);
			return inner(input, { ...init, headers, body, redirect: "error" });
		};

		const accessToken = await getChatGPTAccessToken(options.authPath, inner);
		let response = await send(accessToken);
		const replayable = !(input instanceof Request) && (typeof body === "string" || body === undefined || body === null);

		if (response.status === 401 && options.refreshOnUnauthorized !== false && replayable) {
			let refreshError: unknown;

			try {
				const refreshed = await getChatGPTAccessToken(options.authPath, inner, accessToken);

				if (refreshed && refreshed !== accessToken) {
					await response.body?.cancel().catch(() => undefined);
					response = await send(refreshed);
				}
			} catch (error) {
				refreshError = error;
			}

			if (
				refreshError instanceof ChatGPTError &&
				(refreshError.code === "reauth_required" ||
					refreshError.code === "not_signed_in" ||
					refreshError.code === "plan_usage_disabled")
			) {
				throw refreshError;
			}
		}

		await stopNonRetryable(response);

		if (bufferStream && response.ok) {
			response = await bufferResponsesStream(response);
		}

		return response;
	}) as FetchFunction;
}

export function createChatGPTProvider(options: ChatGPTProviderOptions = {}) {
	return createOpenAI({
		apiKey: "chatgpt-oauth",
		baseURL: "https://api.openai.com/v1",
		fetch: createFetch(options),
	});
}

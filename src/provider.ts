import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
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

const ALLOWED_TOOL_TYPES = new Set([
	"function",
	"custom",
	"namespace",
	"web_search",
	"web_search_2025_08_26",
	"web_search_preview",
]);
const UNSUPPORTED_INPUT_TYPES = new Set(["input_audio", "input_video", "audio", "video"]);
const NON_RETRYABLE_API_CODES = new Set([
	"subscription_sharing_user_not_eligible",
	"subscription_sharing_usage_limit_exceeded",
	"subscription_sharing_unsupported_capability",
	"subscription_sharing_route_not_supported",
	"subscription_sharing_invalid_user",
	"subscription_sharing_v2_client_not_enabled",
	"chatpass_v2_scope_not_authorized",
	"chatpass_v2_invalid_authorization_context",
	"invalid_api_key",
	"invalid_client",
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

function instructionsText(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}

	if (
		Array.isArray(value) &&
		value.every((part) => isObject(part) && (part.type === "text" || part.type === "input_text"))
	) {
		return textOf(value);
	}

	return undefined;
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

		if (item.type === "item_reference") {
			throw new ChatGPTError(
				"unsupported_input",
				"ChatGPT plan usage requires the full conversation history in input. Do not send item_reference.",
			);
		}

		if (item.type === "additional_tools") {
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

		if (
			(tool.type === "function" || tool.type === "custom") &&
			(typeof tool.name !== "string" || tool.name.length === 0)
		) {
			throw new ChatGPTError("invalid_tools", "ChatGPT requires function and custom tools to have a name.");
		}

		if (Array.isArray(tool.allowed_callers) && tool.allowed_callers.includes("programmatic")) {
			throw new ChatGPTError(
				"unsupported_tool",
				"ChatGPT plan usage does not support programmatic tool calling.",
			);
		}

		if (tool.defer_loading === true) {
			throw new ChatGPTError("unsupported_tool", "ChatGPT plan usage does not support deferred tool loading.");
		}

		if (tool.type === "namespace") {
			if (typeof tool.name !== "string" || tool.name.length === 0 || !Array.isArray(tool.tools)) {
				throw new ChatGPTError("invalid_tools", "ChatGPT tool namespaces require a name and tools array.");
			}

			for (const child of tool.tools) {
				if (!isObject(child) || (child.type !== "function" && child.type !== "custom")) {
					throw new ChatGPTError(
						"unsupported_tool",
						"ChatGPT tool namespaces may only contain function or custom tools.",
					);
				}

				if (typeof child.name !== "string" || child.name.length === 0) {
					throw new ChatGPTError("invalid_tools", "ChatGPT requires function and custom tools to have a name.");
				}

				if (Array.isArray(child.allowed_callers) && child.allowed_callers.includes("programmatic")) {
					throw new ChatGPTError(
						"unsupported_tool",
						"ChatGPT plan usage does not support programmatic tool calling.",
					);
				}

				if (child.defer_loading === true) {
					throw new ChatGPTError("unsupported_tool", "ChatGPT plan usage does not support deferred tool loading.");
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
			"Named tool_choice cannot target tools grouped by groupTools. Use auto, required, or none, or provide the tools in your own namespace and disable groupTools.",
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
		const instructions =
			body.instructions === undefined || body.instructions === null ? "" : instructionsText(body.instructions);

		if (instructions === undefined) {
			body.input = [{ role: "developer", content: system }, ...(body.input as unknown[])];
		} else {
			body.instructions = [instructions, system].filter(Boolean).join("\n\n");
		}
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

	if (!data || data.trim() === "[DONE]") {
		return undefined;
	}

	try {
		const value = JSON.parse(data) as unknown;
		return isObject(value) ? value : undefined;
	} catch (error) {
		throw new ChatGPTError("invalid_stream", "ChatGPT returned an invalid response stream.", { cause: error, retryable: true });
	}
}

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

async function readResponseText(response: Response, signal?: AbortSignal): Promise<string> {
	const declared = Number(response.headers.get("content-length"));

	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
		await response.body?.cancel().catch(() => undefined);
		throw new ChatGPTError("response_too_large", "ChatGPT returned a response that is too large.", { retryable: false });
	}

	if (!response.body) {
		return "";
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();

			if (done) {
				break;
			}

			total += value.byteLength;

			if (total > MAX_RESPONSE_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new ChatGPTError("response_too_large", "ChatGPT returned a response that is too large.", {
					retryable: false,
				});
			}

			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof ChatGPTError) {
			throw error;
		}

		if (signal?.aborted) {
			throw new ChatGPTError("cancelled", "The request was cancelled.", { cause: error });
		}

		throw new ChatGPTError("stream_interrupted", "ChatGPT response stream ended unexpectedly.", {
			cause: error,
			retryable: true,
		});
	} finally {
		reader.releaseLock();
	}

	if (signal?.aborted) {
		throw new ChatGPTError("cancelled", "The request was cancelled.");
	}

	const bytes = new Uint8Array(total);
	let offset = 0;

	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return new TextDecoder().decode(bytes);
}

const STREAM_ERROR_STATUS: Record<string, number> = {
	subscription_sharing_usage_limit_exceeded: 429,
	subscription_sharing_usage_unavailable: 503,
	subscription_sharing_user_unavailable: 503,
	subscription_sharing_user_not_eligible: 403,
	subscription_sharing_v2_client_not_enabled: 403,
	subscription_sharing_route_not_supported: 403,
	subscription_sharing_invalid_user: 401,
	subscription_sharing_unsupported_capability: 400,
	chatpass_v2_scope_not_authorized: 403,
	chatpass_v2_invalid_authorization_context: 403,
	rate_limit_exceeded: 429,
	insufficient_quota: 429,
	server_error: 500,
	timeout: 504,
	authentication_error: 401,
	permission_error: 403,
	not_found_error: 404,
};

function streamErrorStatus(body: unknown): number {
	return STREAM_ERROR_STATUS[apiErrorCode(body) ?? ""] ?? 400;
}

async function bufferResponsesStream(response: Response, signal?: AbortSignal): Promise<Response> {
	const text = await readResponseText(response, signal);

	if (signal?.aborted) {
		throw new ChatGPTError("cancelled", "The request was cancelled.");
	}

	const requestId = response.headers.get("openai-request-id") ?? response.headers.get("x-request-id") ?? undefined;
	let terminal: Record<string, unknown> | undefined;
	let sawEvent = false;

	for (const block of text.split(/\r?\n\r?\n/)) {
		const event = parseSseEvent(block);

		if (!event) {
			continue;
		}

		sawEvent = true;

		if (event.type === "response.completed") {
			terminal = isObject(event.response) ? event.response : undefined;
			continue;
		}

		if (event.type === "response.incomplete") {
			if (!isObject(event.response)) {
				throw new ChatGPTError("response_incomplete", "ChatGPT stopped before completing the response.", {
					retryable: false,
					requestId,
				});
			}

			terminal = event.response;
			continue;
		}

		if (event.type === "response.failed") {
			const body = isObject(event.response) ? event.response : event;
			throw apiError(body, streamErrorStatus(body), requestId, response.headers);
		}

		if (event.type === "error") {
			throw apiError(event, streamErrorStatus(event), requestId, response.headers);
		}
	}

	if (!terminal) {
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
				headers.delete("transfer-encoding");
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
	headers.delete("transfer-encoding");
	headers.set("content-type", "application/json");

	if (requestId) {
		headers.set("openai-request-id", requestId);
		headers.set("x-request-id", requestId);
	}

	return new Response(JSON.stringify(terminal), { status: 200, headers });
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
			response.headers,
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

		if (
			endpoint.origin !== "https://api.openai.com" ||
			endpoint.pathname !== "/v1/responses" ||
			endpoint.username !== "" ||
			endpoint.password !== ""
		) {
			throw new ChatGPTError(
				"unsupported_route",
				"ChatGPT plan usage only supports POST https://api.openai.com/v1/responses. Use the provider as a function or call provider.responses().",
			);
		}

		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

		if (method !== "POST") {
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

		if (body === undefined && input instanceof Request && input.bodyUsed) {
			throw new ChatGPTError("invalid_request", "ChatGPT request body has already been consumed.");
		}

		if (body === undefined && input instanceof Request && input.body !== null) {
			try {
				body = await input.clone().text();
			} catch (error) {
				throw new ChatGPTError("invalid_request", "ChatGPT request body could not be read.", { cause: error });
			}

			baseHeaders.delete("content-length");
			baseHeaders.delete("transfer-encoding");
		}

		if (body !== undefined && body !== null && typeof body !== "string") {
			throw new ChatGPTError("invalid_request", "ChatGPT requests must use a JSON string body.");
		}

		if (typeof body === "string") {
			let request: Record<string, unknown>;

			try {
				request = JSON.parse(body) as Record<string, unknown>;
			} catch (error) {
				throw new ChatGPTError("invalid_request", "ChatGPT request body was not valid JSON.", { cause: error });
			}

			bufferStream = request.stream !== true;
			body = JSON.stringify(transformChatGPTRequest(request, groupToolsOption));
			baseHeaders.delete("content-length");
			baseHeaders.delete("transfer-encoding");
		}

		const send = async (accessToken: string) => {
			const headers = new Headers(baseHeaders);
			headers.set("authorization", `Bearer ${accessToken}`);
			return inner(input, { ...init, headers, body, redirect: "error" });
		};

		const accessToken = await getChatGPTAccessToken(options.authPath, inner, undefined, init?.signal ?? undefined);
		let response = await send(accessToken);
		const replayable = typeof body === "string" || body === undefined || body === null;

		if (response.status === 401 && options.refreshOnUnauthorized !== false && replayable) {
			let refreshError: unknown;

			try {
				const refreshed = await getChatGPTAccessToken(
					options.authPath,
					inner,
					accessToken,
					init?.signal ?? undefined,
				);

				if (refreshed && refreshed !== accessToken) {
					await response.body?.cancel().catch(() => undefined);
					response = await send(refreshed);
				}
			} catch (error) {
				refreshError = error;
			}

			if (refreshError !== undefined) {
				await response.body?.cancel().catch(() => undefined);
			}

			if (refreshError instanceof ChatGPTError) {
				throw refreshError;
			}

			if (refreshError !== undefined) {
				throw new ChatGPTError("refresh_failed", "ChatGPT credentials could not be refreshed.", {
					cause: refreshError,
					retryable: true,
				});
			}
		}

		await stopNonRetryable(response);

		if (bufferStream && response.ok) {
			response = await bufferResponsesStream(response, init?.signal ?? undefined);
		}

		return response;
	}) as FetchFunction;
}

function withStoreDisabled<T extends { providerOptions?: Record<string, Record<string, unknown>> }>(options: T): T {
	const openai = options.providerOptions?.openai;

	return {
		...options,
		providerOptions: {
			...options.providerOptions,
			openai: { ...openai, store: false },
		},
	};
}

function wrapResponsesModel(model: LanguageModelV4): LanguageModelV4 {
	return new Proxy(model, {
		get(target, property, receiver) {
			if (property === "doGenerate") {
				return (options: Parameters<LanguageModelV4["doGenerate"]>[0]) =>
					target.doGenerate.call(target, withStoreDisabled(options));
			}

			if (property === "doStream") {
				return (options: Parameters<LanguageModelV4["doStream"]>[0]) =>
					target.doStream.call(target, withStoreDisabled(options));
			}

			return Reflect.get(target, property, target);
		},
	});
}

export function createChatGPTProvider(options: ChatGPTProviderOptions = {}) {
	const base = createOpenAI({
		apiKey: "chatgpt-oauth",
		baseURL: "https://api.openai.com/v1",
		fetch: createFetch(options),
	});
	const provider = ((modelId: string) => wrapResponsesModel(base(modelId))) as typeof base;
	Object.assign(provider, base);
	provider.languageModel = (modelId: string) => wrapResponsesModel(base.languageModel(modelId));
	provider.responses = (modelId: string) => wrapResponsesModel(base.responses(modelId));
	return provider;
}

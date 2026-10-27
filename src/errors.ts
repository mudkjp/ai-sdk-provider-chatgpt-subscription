import { APICallError } from "@ai-sdk/provider";

export interface ChatGPTErrorOptions {
	cause?: unknown;
	param?: string;
	requestId?: string;
	responseBody?: string;
	responseHeaders?: Record<string, string>;
	retryable?: boolean;
	status?: number;
}

export class ChatGPTError extends APICallError {
	readonly code: string;
	readonly requestId?: string;
	readonly param?: string;

	constructor(code: string, message: string, options: ChatGPTErrorOptions = {}) {
		super({
			message,
			url: "https://api.openai.com/v1",
			requestBodyValues: {},
			statusCode: options.status,
			responseHeaders: options.responseHeaders,
			responseBody: options.responseBody,
			cause: options.cause,
			isRetryable: options.retryable ?? false,
		});
		this.name = "ChatGPTError";
		this.code = code;
		this.requestId = options.requestId;
		this.param = options.param;
	}

	get retryable(): boolean {
		return this.isRetryable;
	}

	get status(): number | undefined {
		return this.statusCode;
	}
}

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

const REAUTHENTICATION_CODES = new Set([
	"invalid_grant",
	"invalid_refresh_token",
	"token_expired",
	"refresh_token_expired",
	"refresh_token_invalidated",
	"refresh_token_reused",
]);

const API_MESSAGES: Record<string, [message: string, retryable: boolean]> = {
	subscription_sharing_user_not_eligible: ["ChatGPT plan usage is not available for this account, workspace, or region.", false],
	subscription_sharing_usage_limit_exceeded: [`A ChatGPT usage limit was reached. Manage usage at ${CHATGPT_USAGE_URL}.`, false],
	subscription_sharing_usage_unavailable: ["ChatGPT usage could not be checked. Try again shortly.", true],
	subscription_sharing_unsupported_capability: ["This request uses a feature that ChatGPT plan usage does not support.", false],
	subscription_sharing_route_not_supported: ["ChatGPT plan usage only supports POST /v1/responses on api.openai.com.", false],
	subscription_sharing_invalid_user: ["ChatGPT could not validate this account's subscription context. Sign in again.", false],
	subscription_sharing_user_unavailable: ["This ChatGPT account or workspace is temporarily unavailable. Try again shortly.", true],
	subscription_sharing_v2_client_not_enabled: ["This app is not enabled for ChatGPT plan usage.", false],
	chatpass_v2_scope_not_authorized: ["The granted ChatGPT permissions do not authorize this request.", false],
	chatpass_v2_invalid_authorization_context: ["The ChatGPT authorization context does not permit this request.", false],
	invalid_client: ["ChatGPT rejected the saved client registration. Sign in again.", false],
	invalid_grant: ["ChatGPT did not accept this authorization grant. Sign in again.", false],
	invalid_refresh_token: ["The ChatGPT connection can no longer be renewed. Sign in again.", false],
	token_expired: ["The ChatGPT connection can no longer be renewed. Sign in again.", false],
	refresh_token_expired: ["The ChatGPT connection can no longer be renewed. Sign in again.", false],
	refresh_token_invalidated: ["The ChatGPT connection can no longer be renewed. Sign in again.", false],
	refresh_token_reused: ["The ChatGPT connection can no longer be renewed. Sign in again.", false],
	invalid_api_key: ["ChatGPT did not accept this credential.", false],
	model_not_found: ["This model is not available for this ChatGPT account.", false],
	access_denied: ["ChatGPT sign-in was not completed.", false],
};

export function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeIdentifier(value: unknown, maxLength = 160): string | undefined {
	return typeof value === "string" && value.length <= maxLength && /^[a-zA-Z0-9_][a-zA-Z0-9_.:\[\]-]*$/.test(value)
		? value
		: undefined;
}

function requestIdOf(headers: Headers): string | undefined {
	return safeIdentifier(headers.get("openai-request-id") ?? headers.get("x-request-id"));
}

export function apiErrorCode(body: unknown): string | undefined {
	let detail = body;

	for (let depth = 0; depth < 4 && isObject(detail); depth++) {
		const code = safeIdentifier(typeof detail.error === "string" ? detail.error : detail.code, 100);

		if (code) {
			return code;
		}

		detail = isObject(detail.error) ? detail.error : isObject(detail.detail) ? detail.detail : undefined;
	}

	return undefined;
}

function responseBodyOf(body: unknown): string | undefined {
	if (body === undefined) {
		return undefined;
	}

	if (typeof body === "string") {
		return body;
	}

	try {
		return JSON.stringify(body);
	} catch {
		return undefined;
	}
}

function responseHeadersOf(headers: Headers | Record<string, string> | undefined): Record<string, string> | undefined {
	if (headers === undefined) {
		return undefined;
	}

	return headers instanceof Headers ? Object.fromEntries(headers.entries()) : { ...headers };
}

export function apiError(
	body: unknown,
	status?: number,
	requestId?: string | null,
	responseHeaders?: Headers | Record<string, string>,
): ChatGPTError {
	const code = apiErrorCode(body) ?? "api_error";
	const known = API_MESSAGES[code];
	const detail = isObject(body) ? (isObject(body.error) ? body.error : isObject(body.detail) ? body.detail : body) : undefined;
	const diagnostics = {
		status,
		requestId: safeIdentifier(requestId),
		param: isObject(detail) ? safeIdentifier(detail.param) : undefined,
		responseBody: responseBodyOf(body),
		responseHeaders: responseHeadersOf(responseHeaders),
	};

	if (known) {
		return new ChatGPTError(code, known[0], { ...diagnostics, retryable: known[1] });
	}

	if (status === 400 || status === 422 || code === "invalid_request_error" || code === "invalid_request") {
		return new ChatGPTError(code, "ChatGPT rejected this request. Check the model, input, and supported options.", diagnostics);
	}

	if (status === 401) {
		return new ChatGPTError(code, "ChatGPT did not accept this account's credentials. Sign in again.", diagnostics);
	}

	if (status === 403) {
		return new ChatGPTError(code, "A ChatGPT policy or permission restriction prevented this request.", diagnostics);
	}

	if (status === 429) {
		return new ChatGPTError(code, "ChatGPT is receiving too many requests. Try again shortly.", { ...diagnostics, retryable: true });
	}

	if (status !== undefined && status >= 500) {
		return new ChatGPTError(code, "ChatGPT is temporarily unavailable. Try again shortly.", { ...diagnostics, retryable: true });
	}

	return new ChatGPTError(code, "ChatGPT could not complete this request.", diagnostics);
}

export function isReauthenticationError(error: unknown): boolean {
	return error instanceof ChatGPTError && REAUTHENTICATION_CODES.has(error.code);
}

export async function jsonResponse(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		if (response.ok) {
			throw new ChatGPTError("invalid_response", "ChatGPT returned an unexpected response.", {
				retryable: true,
				status: response.status,
				requestId: requestIdOf(response.headers),
			});
		}

		throw apiError(undefined, response.status, requestIdOf(response.headers), response.headers);
	}
}

export async function fetchRemote(
	url: string,
	init: RequestInit = {},
	fetchImpl: typeof fetch = fetch,
	timeoutMs = 30_000,
): Promise<Response> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

	try {
		return await fetchImpl(url, { ...init, redirect: "error", signal });
	} catch (error) {
		if (init.signal?.aborted) {
			throw new ChatGPTError("cancelled", "The request was cancelled.", { cause: error });
		}

		if (error instanceof ChatGPTError) {
			throw error;
		}

		throw new ChatGPTError("network_error", "Could not reach ChatGPT. Check your connection and try again.", {
			cause: error,
			retryable: true,
		});
	}
}

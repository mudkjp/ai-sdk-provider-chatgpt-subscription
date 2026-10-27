import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createRemoteJWKSet, customFetch, jwtVerify, type RemoteJWKSet } from "jose";
import { JOSEError, JWKSInvalid, JWKSMultipleMatchingKeys, JWKSNoMatchingKey, JWKSTimeout } from "jose/errors";
import { z } from "zod";
import { apiError, ChatGPTError, fetchRemote, isObject, jsonResponse } from "./errors.js";
import type { ChatGPTAccount, ChatGPTTokenSet } from "./storage.js";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", CHATGPT_PLAN_SCOPE].join(" ");
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const CALLBACK_PATH = "/auth/callback";
const CLIENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,200}$/;

const TokenResponseSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1).optional(),
	id_token: z.string().min(1).optional(),
	token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
	expires_in: z.number().positive().finite(),
	scope: z.string().optional(),
	earliest_refresh_at: z.union([z.string(), z.number()]).optional(),
});

type TokenResponse = z.infer<typeof TokenResponseSchema>;

interface Discovery {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	jwksUri: string;
	revocationEndpoint?: string;
}

interface VerifiedIdentity {
	subject: string;
	email?: string;
	name?: string;
}

interface CallbackResult {
	code: string;
	clientId: string;
}

interface CallbackListener {
	result: Promise<CallbackResult>;
	close: () => void;
	redirectUri: string;
}

interface ParsedTokenFields {
	credentials: ChatGPTTokenSet;
	scopes: string[];
}

export interface ChatGPTAuthorization {
	clientId: string;
	subject: string;
	email?: string;
	name?: string;
	idToken: string;
	scopes: string[];
	credentials: ChatGPTTokenSet;
}

export interface ChatGPTAuthorizeOptions {
	appName?: string;
	fetch?: typeof fetch;
	hostId: string;
	onAuthUrl?: (url: string) => void;
	onRegistration?: (clientId: string) => Promise<void>;
	openBrowser?: (url: string) => void | Promise<void>;
	port?: number;
	previous?: ChatGPTAccount;
	reconsent?: boolean;
	signal?: AbortSignal;
}

const discoveries = new WeakMap<typeof fetch, Promise<Discovery>>();
const keySets = new WeakMap<typeof fetch, Map<string, RemoteJWKSet>>();

function randomValue(): string {
	return randomBytes(32).toString("base64url");
}

function unavailableIdentity(cause?: unknown): ChatGPTError {
	return new ChatGPTError(
		"identity_verification_unavailable",
		"ChatGPT identity verification is temporarily unavailable. Your connection was preserved. Try again shortly.",
		{ cause, retryable: true },
	);
}

function discoveryError(cause?: unknown): ChatGPTError {
	return new ChatGPTError("discovery_failed", "ChatGPT sign-in configuration could not be verified.", {
		cause,
		retryable: true,
	});
}

async function discover(fetchImpl: typeof fetch = fetch): Promise<Discovery> {
	let discovery = discoveries.get(fetchImpl);

	if (!discovery) {
		discovery = (async () => {
			const response = await fetchRemote(
				`${ISSUER}/.well-known/openid-configuration`,
				{ headers: { accept: "application/json" } },
				fetchImpl,
				15_000,
			);
			const data = await jsonResponse(response);

			if (!response.ok) {
				throw apiError(data, response.status, response.headers.get("x-request-id"), response.headers);
			}

			if (!isObject(data) || data.issuer !== ISSUER) {
				throw discoveryError();
			}

			const endpoint = (key: string, required = true): string | undefined => {
				const value = data[key];

				if ((value === undefined || value === null) && !required) {
					return undefined;
				}

				if (typeof value !== "string") {
					throw discoveryError();
				}

				try {
					if (new URL(value).origin !== ISSUER) {
						throw discoveryError();
					}
				} catch {
					throw discoveryError();
				}

				return value;
			};

			return {
				authorizationEndpoint: endpoint("authorization_endpoint")!,
				tokenEndpoint: endpoint("token_endpoint")!,
				jwksUri: endpoint("jwks_uri")!,
				revocationEndpoint: endpoint("revocation_endpoint", false),
			};
		})().catch((error: unknown) => {
			discoveries.delete(fetchImpl);
			throw error;
		});
		discoveries.set(fetchImpl, discovery);
	}

	return discovery;
}

function keysFor(uri: string, fetchImpl: typeof fetch): RemoteJWKSet {
	let sets = keySets.get(fetchImpl);

	if (!sets) {
		sets = new Map();
		keySets.set(fetchImpl, sets);
	}

	let keys = sets.get(uri);

	if (!keys) {
		keys = createRemoteJWKSet(new URL(uri), {
			timeoutDuration: 15_000,
			[customFetch]: async (url, init) => {
				try {
					const response = await fetchImpl(url, { ...init, redirect: "error" });

					if (!response.ok) {
						throw unavailableIdentity();
					}

					const body = await response.clone().json().catch(() => undefined);

					if (!isObject(body) || !Array.isArray(body.keys)) {
						throw unavailableIdentity();
					}

					return response;
				} catch (error) {
					if (error instanceof ChatGPTError && error.code === "identity_verification_unavailable") {
						throw error;
					}

					throw unavailableIdentity(error);
				}
			},
		});
		sets.set(uri, keys);
	}

	return keys;
}

export async function verifyChatGPTIdentity(
	idToken: string,
	clientId: string,
	nonce?: string,
	receivedAt?: number,
	fetchImpl: typeof fetch = fetch,
): Promise<VerifiedIdentity> {
	const config = await discover(fetchImpl).catch((error: unknown) => {
		throw unavailableIdentity(error);
	});
	const keys = keysFor(config.jwksUri, fetchImpl);

	try {
		const { payload } = await jwtVerify(idToken, keys, {
			issuer: ISSUER,
			audience: clientId,
			algorithms: ["RS256"],
			clockTolerance: 5,
			requiredClaims: ["iss", "aud", "exp", "iat", "sub"],
			...(receivedAt === undefined ? {} : { currentDate: new Date(receivedAt) }),
		});

		if (typeof payload.sub !== "string" || !payload.sub) {
			throw new ChatGPTError("invalid_id_token", "ChatGPT identity could not be verified. Sign in again.");
		}

		if (nonce !== undefined && payload.nonce !== nonce) {
			throw new ChatGPTError("invalid_id_token", "The ChatGPT sign-in nonce did not match. Sign in again.");
		}

		if (payload.azp !== undefined && payload.azp !== clientId) {
			throw new ChatGPTError("invalid_id_token", "ChatGPT identity could not be verified. Sign in again.");
		}

		if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) {
			throw new ChatGPTError("invalid_id_token", "ChatGPT identity could not be verified. Sign in again.");
		}

		return {
			subject: payload.sub,
			email: typeof payload.email === "string" ? payload.email : undefined,
			name: typeof payload.name === "string" ? payload.name : undefined,
		};
	} catch (error) {
		if (error instanceof ChatGPTError) {
			throw error;
		}

		if (
			error instanceof JWKSTimeout ||
			error instanceof JWKSInvalid ||
			error instanceof JWKSNoMatchingKey ||
			error instanceof JWKSMultipleMatchingKeys
		) {
			throw unavailableIdentity(error);
		}

		if (error instanceof JOSEError) {
			throw new ChatGPTError("invalid_id_token", "ChatGPT identity could not be verified. Sign in again.", { cause: error });
		}

		throw unavailableIdentity(error);
	}
}

function pkce(): { verifier: string; challenge: string } {
	const verifier = randomValue();
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url"),
	};
}

function parseEarliestRefreshAt(value: unknown): number | undefined {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;

	if (Number.isFinite(numeric)) {
		return numeric > 0 ? (numeric > 1e12 ? numeric : numeric * 1000) : undefined;
	}

	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}

	return undefined;
}

function tokenFields(
	token: TokenResponse,
	previous?: { scopes: string[]; refreshToken?: string },
	requireRefresh = false,
): ParsedTokenFields {
	const scopes = token.scope === undefined ? previous?.scopes : token.scope.trim().split(/\s+/).filter(Boolean);
	const refreshToken = token.refresh_token ?? previous?.refreshToken;

	const expiresAt = Date.now() + token.expires_in * 1000;

	if (
		!scopes?.length ||
		!Number.isFinite(expiresAt) ||
		((requireRefresh || scopes.includes("offline_access")) && !refreshToken)
	) {
		throw new ChatGPTError("invalid_token_response", "ChatGPT returned incomplete credentials. Sign in again.");
	}

	return {
		credentials: {
			accessToken: token.access_token,
			refreshToken,
			expiresAt,
			earliestRefreshAt: parseEarliestRefreshAt(token.earliest_refresh_at),
		},
		scopes,
	};
}

function parseTokenResponse(value: unknown): TokenResponse {
	const parsed = TokenResponseSchema.safeParse(value);

	if (!parsed.success) {
		throw new ChatGPTError("invalid_token_response", "ChatGPT returned incomplete credentials. Sign in again.", {
			cause: parsed.error,
		});
	}

	return parsed.data;
}

async function tokenRequest(
	body: URLSearchParams,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const config = await discover(fetchImpl);
	const response = await fetchRemote(
		config.tokenEndpoint,
		{
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/x-www-form-urlencoded",
			},
			body,
			signal,
		},
		fetchImpl,
	);
	const data = await jsonResponse(response);

	if (!response.ok) {
		throw apiError(data, response.status, response.headers.get("x-request-id"), response.headers);
	}

	if (!isObject(data)) {
		throw new ChatGPTError("invalid_token_response", "ChatGPT returned an invalid token response. Sign in again.");
	}

	return data;
}

async function createCallbackServer(handler: RequestListener, port: number): Promise<Server> {
	const attempt = (candidate: number): Promise<Server> =>
		new Promise((resolveResult, rejectResult) => {
			const server = createServer(handler);
			server.once("error", rejectResult);
			server.once("listening", () => resolveResult(server));
			server.listen(candidate, "127.0.0.1");
		});

	try {
		return await attempt(port);
	} catch (error) {
		if (port !== 0 && (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
			return attempt(0);
		}

		throw new ChatGPTError("callback_port_unavailable", "The local sign-in callback could not start.", { cause: error });
	}
}

async function listenForCallback(
	port: number,
	state: string,
	savedClientId: string | undefined,
	signal?: AbortSignal,
): Promise<CallbackListener> {
	let resolveResult: (value: CallbackResult) => void;
	let rejectResult: (error: unknown) => void;
	let settled = false;
	let actualPort = port;
	const result = new Promise<CallbackResult>((resolveCallback, rejectCallback) => {
		resolveResult = resolveCallback;
		rejectResult = rejectCallback;
	});
	void result.catch(() => undefined);

	const finish = (error?: Error, value?: CallbackResult) => {
		if (settled) {
			return;
		}

		settled = true;

		if (error) {
			rejectResult(error);
		} else {
			resolveResult(value!);
		}
	};

	const handler: RequestListener = (request, response) => {
		response.setHeader("cache-control", "no-store");
		response.setHeader("referrer-policy", "no-referrer");
		const origin = `http://127.0.0.1:${actualPort}`;
		let url: URL;

		try {
			url = new URL(request.url ?? "/", origin);
		} catch {
			response.writeHead(400).end("Invalid request.");
			return;
		}

		if (request.method !== "GET" || request.headers.host !== `127.0.0.1:${actualPort}` || url.origin !== origin) {
			response.writeHead(404).end("Not found.");
			return;
		}

		if (url.pathname === "/auth/complete") {
			response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("You can close this window.");
			return;
		}

		if (url.pathname !== CALLBACK_PATH) {
			response.writeHead(404).end("Not found.");
			return;
		}

		const states = url.searchParams.getAll("state");
		const receivedState = Buffer.from(states.length === 1 ? states[0]! : "");
		const expectedState = Buffer.from(state);

		if (
			states.length !== 1 ||
			receivedState.length !== expectedState.length ||
			!timingSafeEqual(receivedState, expectedState)
		) {
			response.writeHead(400).end("Invalid sign-in state. Return to the browser tab that started sign-in.");
			return;
		}

		const error = url.searchParams.get("error");

		if (error) {
			response.writeHead(400).end("ChatGPT sign-in was not completed. Return to the terminal.");
			finish(
				new ChatGPTError(
					error === "access_denied" ? "access_denied" : "authorization_failed",
					error === "access_denied" ? "ChatGPT sign-in was cancelled." : `ChatGPT sign-in failed: ${error}`,
				),
			);
			return;
		}

		const codes = url.searchParams.getAll("code");
		const clientIds = url.searchParams.getAll("client_id");
		const returnedClientId = clientIds[0];
		const clientId = returnedClientId ?? savedClientId;

		if (
			codes.length !== 1 ||
			!codes[0] ||
			clientIds.length > 1 ||
			!clientId ||
			!CLIENT_ID_PATTERN.test(clientId) ||
			clientId === DYNAMIC_CLIENT_ID ||
			(savedClientId !== undefined && returnedClientId !== undefined && savedClientId !== returnedClientId)
		) {
			response.writeHead(400).end("ChatGPT did not complete app registration. Return to the terminal and try again.");
			finish(
				new ChatGPTError(
					"registration_incomplete",
					"ChatGPT did not complete app registration. Try signing in again.",
				),
			);
			return;
		}

		response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Signed in</title></head>
<body style="font:17px system-ui;max-width:32rem;margin:18vh auto;padding:24px">
<p>Signed in with ChatGPT. You can close this window.</p>
<script>history.replaceState(null, "", "/auth/complete")</script>
</body>
</html>`);
		finish(undefined, { code: codes[0], clientId });
	};

	const server = await createCallbackServer(handler, port);
	const address = server.address();

	if (address && typeof address !== "string") {
		actualPort = address.port;
	}

	server.requestTimeout = 15_000;
	server.headersTimeout = 10_000;
	server.on("error", (error) => {
		finish(new ChatGPTError("callback_failed", "The local sign-in listener stopped. Try again.", { cause: error, retryable: true }));
	});

	const onAbort = () => {
		finish(new ChatGPTError("cancelled", "ChatGPT sign-in was cancelled."));
	};

	if (signal?.aborted) {
		onAbort();
	} else {
		signal?.addEventListener("abort", onAbort, { once: true });
	}

	const close = () => {
		signal?.removeEventListener("abort", onAbort);
		server.close();
		server.closeAllConnections();
	};

	return {
		result,
		close,
		redirectUri: `http://127.0.0.1:${actualPort}${CALLBACK_PATH}`,
	};
}

export async function authorizeChatGPT(options: ChatGPTAuthorizeOptions): Promise<ChatGPTAuthorization> {
	if (options.signal?.aborted) {
		throw new ChatGPTError("cancelled", "ChatGPT sign-in was cancelled.");
	}

	const fetchImpl = options.fetch ?? fetch;
	const port = options.port ?? 1455;

	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new ChatGPTError("invalid_port", "The sign-in callback port must be an integer from 0 to 65535.");
	}

	const config = await discover(fetchImpl);
	const state = randomValue();
	const nonce = randomValue();
	const { verifier, challenge } = pkce();
	const listener = await listenForCallback(port, state, options.previous?.clientId, options.signal);

	try {
		if (options.signal?.aborted) {
			throw new ChatGPTError("cancelled", "ChatGPT sign-in was cancelled.");
		}

		const authorization = new URL(config.authorizationEndpoint);
		authorization.search = new URLSearchParams({
			client_id: options.previous?.clientId ?? DYNAMIC_CLIENT_ID,
			ext_agent_host_id: options.hostId,
			response_type: "code",
			redirect_uri: listener.redirectUri,
			resource: RESOURCE,
			scope: SCOPES,
			state,
			nonce,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();

		if (!options.previous?.clientId) {
			authorization.searchParams.set(
				"agent_name_hint",
				options.appName ?? "ai-sdk-provider-chatgpt-subscription",
			);
		}

		if (options.previous?.email) {
			authorization.searchParams.set("login_hint", options.previous.email);
		}

		if (options.reconsent) {
			authorization.searchParams.set("prompt", "consent");
		}

		const notify = options.onAuthUrl ?? ((url: string) => {
			console.log(`Open this URL to sign in with ChatGPT:\n${url}`);
		});
		notify(authorization.toString());
		await options.openBrowser?.(authorization.toString());

		const callback = await listener.result;
		await options.onRegistration?.(callback.clientId);

		const token = parseTokenResponse(
			await tokenRequest(
				new URLSearchParams({
					grant_type: "authorization_code",
					client_id: callback.clientId,
					code: callback.code,
					code_verifier: verifier,
					redirect_uri: listener.redirectUri,
					resource: RESOURCE,
				}),
				fetchImpl,
				options.signal,
			),
		);
		const idToken = token.id_token;

		if (!idToken) {
			throw new ChatGPTError("invalid_id_token", "ChatGPT did not return a verifiable identity. Sign in again.");
		}

		const identity = await verifyChatGPTIdentity(idToken, callback.clientId, nonce, undefined, fetchImpl);

		if (options.previous?.subject && options.previous.subject !== identity.subject) {
			throw new ChatGPTError(
				"account_mismatch",
				"This sign-in returned a different ChatGPT account. Use a separate auth file for each account.",
			);
		}

		if (options.signal?.aborted) {
			throw new ChatGPTError("cancelled", "ChatGPT sign-in was cancelled.");
		}

		return {
			clientId: callback.clientId,
			...identity,
			idToken,
			...tokenFields(token),
		};
	} finally {
		listener.close();
	}
}

export async function refreshChatGPTTokens(
	account: ChatGPTAccount,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<{ credentials: ChatGPTTokenSet; scopes: string[]; idToken?: string; receivedAt: number }> {
	const refreshToken = account.credentials?.refreshToken;

	if (!refreshToken) {
		throw new ChatGPTError("not_signed_in", "ChatGPT is not signed in. Run `chatgpt-subscription login` first.");
	}

	const token = parseTokenResponse(
		await tokenRequest(
			new URLSearchParams({
				grant_type: "refresh_token",
				client_id: account.clientId,
				refresh_token: refreshToken,
				resource: RESOURCE,
			}),
			fetchImpl,
			signal,
		),
	);

	return {
		...tokenFields(token, { scopes: account.scopes, refreshToken }, true),
		idToken: token.id_token,
		receivedAt: Date.now(),
	};
}

export async function revokeChatGPTTokens(account: ChatGPTAccount, fetchImpl: typeof fetch = fetch): Promise<boolean> {
	const refreshToken = account.pendingRefresh?.credentials.refreshToken ?? account.credentials?.refreshToken;

	if (!refreshToken) {
		return true;
	}

	const config = await discover(fetchImpl);

	if (!config.revocationEndpoint) {
		return false;
	}

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const response = await fetchRemote(
				config.revocationEndpoint,
				{
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({
						token: refreshToken,
						token_type_hint: "refresh_token",
						client_id: account.clientId,
					}),
				},
				fetchImpl,
				10_000,
			);
			await response.body?.cancel().catch(() => undefined);

			if (response.status === 200) {
				return true;
			}

			if (response.status < 500 || attempt === 1) {
				return false;
			}
		} catch {
			if (attempt === 1) {
				return false;
			}
		}

		await delay(300);
	}

	return false;
}

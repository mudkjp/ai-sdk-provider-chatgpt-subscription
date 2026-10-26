import { ChatGPTError, isReauthenticationError } from "./errors.js";
import {
	authorizeChatGPT,
	CHATGPT_PLAN_SCOPE,
	refreshChatGPTTokens,
	revokeChatGPTTokens,
	verifyChatGPTIdentity,
} from "./oauth.js";
import {
	chatGPTAuthPath,
	getChatGPTHostId,
	readChatGPTAccount,
	withChatGPTAccountLock,
	writeChatGPTAccount,
	type ChatGPTAccount,
	type ChatGPTTokenSet,
} from "./storage.js";

export interface ChatGPTLoginOptions {
	appName?: string;
	authPath?: string;
	fetch?: typeof fetch;
	onAuthUrl?: (url: string) => void;
	openBrowser?: (url: string) => void | Promise<void>;
	port?: number;
	reconsent?: boolean;
	signal?: AbortSignal;
}

export interface ChatGPTLoginResult {
	authPath: string;
	clientId: string;
	email?: string;
	name?: string;
	planUsage: boolean;
}

export interface ChatGPTStatus {
	authPath: string;
	signedIn: boolean;
	planUsage: boolean;
	clientId?: string;
	email?: string;
	name?: string;
	subject?: string;
	scopes: string[];
	expiresAt?: number;
	reauthRequired: boolean;
}

export interface ChatGPTLogoutOptions {
	authPath?: string;
	fetch?: typeof fetch;
}

export interface ChatGPTLogoutResult {
	authPath: string;
	remoteRevoked: boolean;
}

export interface ChatGPTRequestOptions {
	authPath?: string;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

function notSignedIn(): ChatGPTError {
	return new ChatGPTError("not_signed_in", "ChatGPT is not signed in. Run `chatgpt-subscription login` first.");
}

function reauthenticationRequired(): ChatGPTError {
	return new ChatGPTError(
		"reauth_required",
		"The ChatGPT connection can no longer be renewed. Run `chatgpt-subscription login` again.",
	);
}

function planUsageDisabled(): ChatGPTError {
	return new ChatGPTError(
		"plan_usage_disabled",
		"ChatGPT plan usage was not granted. Run `chatgpt-subscription login --consent` and allow plan usage.",
	);
}

function accountMismatch(): ChatGPTError {
	return new ChatGPTError(
		"account_mismatch",
		"Another ChatGPT account is already saved at this path. Use a separate auth file for each account.",
	);
}

function hasPlanUsage(account: ChatGPTAccount): boolean {
	return account.scopes.includes(CHATGPT_PLAN_SCOPE);
}

function assertPlanUsage(account: ChatGPTAccount): void {
	if (!hasPlanUsage(account)) {
		throw planUsageDisabled();
	}
}

function assertActive(account: ChatGPTAccount): void {
	if (account.reauthRequired) {
		throw reauthenticationRequired();
	}
}

function refreshAt(credentials: ChatGPTTokenSet): number {
	return Math.max(credentials.earliestRefreshAt ?? 0, credentials.expiresAt - 60_000);
}

async function clearCredentials(authPath: string, account: ChatGPTAccount, reauthRequired: boolean): Promise<void> {
	await writeChatGPTAccount(authPath, {
		...account,
		credentials: undefined,
		pendingRefresh: undefined,
		idToken: undefined,
		reauthRequired,
		savedAt: new Date().toISOString(),
	});
}

async function resolvePendingIdentity(
	authPath: string,
	account: ChatGPTAccount,
	fetchImpl: typeof fetch,
): Promise<ChatGPTAccount> {
	const pending = account.pendingRefresh;

	if (!pending) {
		return account;
	}

	try {
		const identity = await verifyChatGPTIdentity(
			pending.idToken,
			account.clientId,
			undefined,
			pending.receivedAt,
			fetchImpl,
		);

		if (account.subject && identity.subject !== account.subject) {
			throw new ChatGPTError("account_mismatch", "The refreshed ChatGPT identity does not match this account.");
		}

		const next: ChatGPTAccount = {
			...account,
			subject: identity.subject,
			email: identity.email ?? account.email,
			name: identity.name ?? account.name,
			idToken: pending.idToken,
			scopes: pending.scopes,
			credentials: pending.credentials,
			pendingRefresh: undefined,
			reauthRequired: false,
			savedAt: new Date().toISOString(),
		};
		await writeChatGPTAccount(authPath, next);
		return next;
	} catch (error) {
		if (error instanceof ChatGPTError && error.code === "identity_verification_unavailable") {
			throw error;
		}

		await clearCredentials(authPath, account, true);
		throw new ChatGPTError("reauth_required", "ChatGPT identity verification failed. Sign in again.", {
			cause: error,
		});
	}
}

async function refreshLocked(authPath: string, fetchImpl: typeof fetch, staleAccessToken?: string): Promise<string> {
	let account = await readChatGPTAccount(authPath);

	if (!account) {
		throw notSignedIn();
	}

	assertPlanUsage(account);
	assertActive(account);

	if (account.pendingRefresh) {
		account = await resolvePendingIdentity(authPath, account, fetchImpl);
		assertPlanUsage(account);
	}

	if (!account.credentials) {
		throw notSignedIn();
	}

	const current = account.credentials;
	const stillFresh = Date.now() < refreshAt(current);

	if (staleAccessToken === undefined ? stillFresh : current.accessToken !== staleAccessToken && stillFresh) {
		return current.accessToken;
	}

	if (!current.refreshToken) {
		await clearCredentials(authPath, account, true);
		throw reauthenticationRequired();
	}

	let refreshed: Awaited<ReturnType<typeof refreshChatGPTTokens>>;

	try {
		refreshed = await refreshChatGPTTokens(account, fetchImpl);
	} catch (error) {
		if (isReauthenticationError(error)) {
			await clearCredentials(authPath, account, true);
		}

		throw error;
	}

	if (refreshed.idToken) {
		const refreshToken = refreshed.credentials.refreshToken;

		if (!refreshToken) {
			await clearCredentials(authPath, account, true);
			throw reauthenticationRequired();
		}

		account = {
			...account,
			pendingRefresh: {
				credentials: { ...refreshed.credentials, refreshToken },
				scopes: refreshed.scopes,
				idToken: refreshed.idToken,
				receivedAt: refreshed.receivedAt,
			},
			savedAt: new Date().toISOString(),
		};
		await writeChatGPTAccount(authPath, account);
		account = await resolvePendingIdentity(authPath, account, fetchImpl);
	} else {
		account = {
			...account,
			credentials: refreshed.credentials,
			scopes: refreshed.scopes,
			pendingRefresh: undefined,
			reauthRequired: false,
			savedAt: new Date().toISOString(),
		};
		await writeChatGPTAccount(authPath, account);
	}

	assertPlanUsage(account);

	if (!account.credentials) {
		throw reauthenticationRequired();
	}

	return account.credentials.accessToken;
}

async function saveAccount(authPath: string, account: ChatGPTAccount): Promise<void> {
	await withChatGPTAccountLock(authPath, async () => {
		const current = await readChatGPTAccount(authPath);

		if (current && current.clientId !== account.clientId) {
			throw accountMismatch();
		}

		await writeChatGPTAccount(authPath, account);
	});
}

export async function loginChatGPT(options: ChatGPTLoginOptions = {}): Promise<ChatGPTLoginResult> {
	const authPath = options.authPath ?? chatGPTAuthPath();
	const fetchImpl = options.fetch ?? fetch;
	const previous = await readChatGPTAccount(authPath);
	const hostId = await getChatGPTHostId(authPath);
	const authorization = await authorizeChatGPT({
		appName: options.appName,
		fetch: fetchImpl,
		hostId,
		onAuthUrl: options.onAuthUrl,
		openBrowser: options.openBrowser,
		port: options.port,
		previous,
		reconsent: options.reconsent,
		signal: options.signal,
		onRegistration: async (clientId) => {
			await withChatGPTAccountLock(authPath, async () => {
				const current = await readChatGPTAccount(authPath);

				if (current && current.clientId !== clientId) {
					throw accountMismatch();
				}

				if (!current) {
					await writeChatGPTAccount(authPath, {
						version: 1,
						clientId,
						scopes: [],
						savedAt: new Date().toISOString(),
					});
				}
			});
		},
	});
	const account: ChatGPTAccount = {
		version: 1,
		clientId: authorization.clientId,
		subject: authorization.subject,
		email: authorization.email,
		name: authorization.name,
		idToken: authorization.idToken,
		scopes: authorization.scopes,
		savedAt: new Date().toISOString(),
		credentials: authorization.credentials,
		reauthRequired: false,
	};
	await saveAccount(authPath, account);

	return {
		authPath,
		clientId: authorization.clientId,
		email: authorization.email,
		name: authorization.name,
		planUsage: authorization.scopes.includes(CHATGPT_PLAN_SCOPE),
	};
}

export async function getChatGPTAccessToken(
	authPath = chatGPTAuthPath(),
	fetchImpl: typeof fetch = fetch,
	staleAccessToken?: string,
): Promise<string> {
	if (staleAccessToken !== undefined) {
		return withChatGPTAccountLock(authPath, () => refreshLocked(authPath, fetchImpl, staleAccessToken));
	}

	const account = await readChatGPTAccount(authPath);

	if (!account) {
		throw notSignedIn();
	}

	assertPlanUsage(account);
	assertActive(account);

	if (account.pendingRefresh) {
		return withChatGPTAccountLock(authPath, async () => {
			const current = await readChatGPTAccount(authPath);

			if (!current) {
				throw notSignedIn();
			}

			const resolved = await resolvePendingIdentity(authPath, current, fetchImpl);
			assertPlanUsage(resolved);

			if (!resolved.credentials) {
				throw reauthenticationRequired();
			}

			if (Date.now() >= refreshAt(resolved.credentials)) {
				return refreshLocked(authPath, fetchImpl);
			}

			return resolved.credentials.accessToken;
		});
	}

	if (!account.credentials) {
		throw notSignedIn();
	}

	if (Date.now() < refreshAt(account.credentials)) {
		return account.credentials.accessToken;
	}

	return withChatGPTAccountLock(authPath, () => refreshLocked(authPath, fetchImpl));
}

export async function getChatGPTStatus(authPath = chatGPTAuthPath()): Promise<ChatGPTStatus> {
	const account = await readChatGPTAccount(authPath);

	return {
		authPath,
		signedIn: Boolean(account?.credentials || account?.pendingRefresh),
		planUsage: account ? hasPlanUsage(account) : false,
		clientId: account?.clientId,
		email: account?.email,
		name: account?.name,
		subject: account?.subject,
		scopes: account?.scopes ?? [],
		expiresAt: account?.credentials?.expiresAt,
		reauthRequired: account?.reauthRequired === true,
	};
}

export async function logoutChatGPT(options: ChatGPTLogoutOptions = {}): Promise<ChatGPTLogoutResult> {
	const authPath = options.authPath ?? chatGPTAuthPath();
	const account = await readChatGPTAccount(authPath);

	if (!account) {
		return { authPath, remoteRevoked: true };
	}

	let remoteRevoked = false;

	try {
		remoteRevoked = await revokeChatGPTTokens(account, options.fetch ?? fetch);
	} catch {
		remoteRevoked = false;
	}

	await withChatGPTAccountLock(authPath, async () => {
		const current = await readChatGPTAccount(authPath);

		if (current) {
			await clearCredentials(authPath, current, false);
		}
	});

	return { authPath, remoteRevoked };
}

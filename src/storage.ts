import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { lock } from "proper-lockfile";
import { z } from "zod";
import { ChatGPTError, isObject } from "./errors.js";

const MAX_FILE_BYTES = 1024 * 1024;
const HOST_ID_PATTERN = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,200}$/;

const TokenSetSchema = z.object({
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1).optional(),
	expiresAt: z.number().finite(),
	earliestRefreshAt: z.number().finite().optional(),
});

const PendingRefreshSchema = z.object({
	credentials: TokenSetSchema.extend({ refreshToken: z.string().min(1) }),
	scopes: z.array(z.string()),
	idToken: z.string().min(1),
	receivedAt: z.number().finite(),
});

const AccountSchema = z.object({
	version: z.literal(1),
	clientId: z.string().regex(CLIENT_ID_PATTERN).refine((value) => value !== "dynamic_agent_client"),
	subject: z.string().optional(),
	email: z.string().optional(),
	name: z.string().optional(),
	idToken: z.string().optional(),
	scopes: z.array(z.string()),
	savedAt: z.string().min(1),
	credentials: TokenSetSchema.optional(),
	pendingRefresh: PendingRefreshSchema.optional(),
	reauthRequired: z.boolean().optional(),
});

export type ChatGPTTokenSet = z.infer<typeof TokenSetSchema>;
export type ChatGPTPendingRefresh = z.infer<typeof PendingRefreshSchema>;
export type ChatGPTAccount = z.infer<typeof AccountSchema>;

function chatGPTConfigDirectory(): string {
	return process.env.CHATGPT_CONFIG_DIR || resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "chatgpt-subscription");
}

export function chatGPTAuthPath(configDirectory?: string): string {
	if (configDirectory !== undefined) {
		return resolve(configDirectory, "auth.json");
	}

	return process.env.CHATGPT_AUTH_PATH || resolve(chatGPTConfigDirectory(), "auth.json");
}

function chatGPTHostPath(authPath = chatGPTAuthPath()): string {
	return resolve(dirname(authPath), "host.json");
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function validateAccount(value: unknown): ChatGPTAccount {
	const parsed = AccountSchema.safeParse(value);

	if (!parsed.success) {
		throw new ChatGPTError("storage_invalid", "Saved ChatGPT credentials are invalid. Sign in again.", {
			cause: parsed.error,
		});
	}

	const account = parsed.data;

	if (account.credentials && !account.credentials.refreshToken && account.scopes.includes("offline_access")) {
		throw new ChatGPTError("storage_invalid", "Saved ChatGPT credentials are incomplete. Sign in again.");
	}

	return account;
}

export async function readChatGPTAccount(authPath = chatGPTAuthPath()): Promise<ChatGPTAccount | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;

	try {
		handle = await open(authPath, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
	} catch (error) {
		if (hasCode(error, "ENOENT")) {
			return undefined;
		}

		throw new ChatGPTError("storage_error", "Saved ChatGPT credentials could not be read.", { cause: error });
	}

	try {
		const info = await handle.stat();

		if (!info.isFile() || info.size > MAX_FILE_BYTES) {
			throw new ChatGPTError("storage_invalid", "Saved ChatGPT credentials are invalid. Sign in again.");
		}

		if (process.platform !== "win32" && process.getuid && info.uid !== process.getuid()) {
			throw new ChatGPTError("storage_unsafe", "Saved ChatGPT credentials must belong to the current user.");
		}

		if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
			await handle.chmod(0o600).catch(() => undefined);
		}

		return validateAccount(JSON.parse(await handle.readFile("utf8")));
	} catch (error) {
		if (error instanceof ChatGPTError) {
			throw error;
		}

		if (error instanceof SyntaxError) {
			throw new ChatGPTError("storage_invalid", "Saved ChatGPT credentials are invalid. Sign in again.", { cause: error });
		}

		throw new ChatGPTError("storage_error", "Saved ChatGPT credentials could not be read.", { cause: error });
	} finally {
		await handle.close();
	}
}

export async function writeChatGPTAccount(authPath: string, account: ChatGPTAccount): Promise<void> {
	validateAccount(account);
	const directory = dirname(authPath);
	const temporary = resolve(directory, `.auth.${randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;

	try {
		const createdDirectory = await mkdir(directory, { recursive: true, mode: 0o700 });

		if (createdDirectory) {
			await chmod(createdDirectory, 0o700).catch(() => undefined);
		}

		handle = await open(temporary, "wx", 0o600);

		if (process.platform !== "win32") {
			await handle.chmod(0o600).catch(() => undefined);
		}

		await handle.writeFile(`${JSON.stringify(account, null, 2)}\n`);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, authPath);
	} catch (error) {
		throw new ChatGPTError("storage_error", "ChatGPT credentials could not be saved.", { cause: error });
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

export async function withChatGPTAccountLock<T>(authPath: string, operation: () => Promise<T>): Promise<T> {
	let release: (() => Promise<void>) | undefined;

	try {
		const createdDirectory = await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });

		if (createdDirectory) {
			await chmod(createdDirectory, 0o700).catch(() => undefined);
		}

		release = await lock(authPath, {
			realpath: false,
			stale: 120_000,
			update: 20_000,
			retries: { retries: 30, factor: 1.2, minTimeout: 100, maxTimeout: 1_000 },
		});
		return await operation();
	} catch (error) {
		if (error instanceof ChatGPTError) {
			throw error;
		}

		if (hasCode(error, "ELOCKED")) {
			throw new ChatGPTError("storage_busy", "Another process is updating ChatGPT credentials. Try again shortly.", {
				cause: error,
				retryable: true,
			});
		}

		throw new ChatGPTError("storage_error", "ChatGPT credentials could not be updated.", { cause: error });
	} finally {
		await release?.().catch(() => undefined);
	}
}

async function withChatGPTHostLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	let release: (() => Promise<void>) | undefined;

	try {
		const createdDirectory = await mkdir(dirname(path), { recursive: true, mode: 0o700 });

		if (createdDirectory) {
			await chmod(createdDirectory, 0o700).catch(() => undefined);
		}

		release = await lock(path, {
			realpath: false,
			stale: 30_000,
			update: 10_000,
			retries: { retries: 50, factor: 1.2, minTimeout: 20, maxTimeout: 200 },
		});
		return await operation();
	} catch (error) {
		if (error instanceof ChatGPTError) {
			throw error;
		}

		if (hasCode(error, "ELOCKED")) {
			throw new ChatGPTError("host_identity_invalid", "Another process is updating the ChatGPT host ID. Try again shortly.", {
				cause: error,
				retryable: true,
			});
		}

		throw new ChatGPTError("host_identity_invalid", "The ChatGPT host ID could not be updated.", { cause: error });
	} finally {
		await release?.().catch(() => undefined);
	}
}

export async function getChatGPTHostId(authPath = chatGPTAuthPath()): Promise<string> {
	const path = chatGPTHostPath(authPath);

	return withChatGPTHostLock(path, async () => {
		const read = async (): Promise<string | undefined> => {
			try {
				const value = JSON.parse(await readFile(path, "utf8")) as unknown;

				if (!isObject(value) || value.version !== 1 || typeof value.id !== "string" || !HOST_ID_PATTERN.test(value.id)) {
					throw new ChatGPTError(
						"host_identity_invalid",
						"The saved ChatGPT host ID is invalid. Restore host.json or remove it to create a new host.",
					);
				}

				return value.id;
			} catch (error) {
				if (hasCode(error, "ENOENT")) {
					return undefined;
				}

				if (error instanceof ChatGPTError) {
					throw error;
				}

				throw new ChatGPTError("host_identity_invalid", "The saved ChatGPT host ID could not be read.", { cause: error });
			}
		};

		const existing = await read();

		if (existing) {
			return existing;
		}

		const id = `urn:uuid:${randomUUID()}`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let created = false;

		try {
			handle = await open(path, "wx", 0o600);
			created = true;

			if (process.platform !== "win32") {
				await handle.chmod(0o600).catch(() => undefined);
			}

			await handle.writeFile(`${JSON.stringify({ version: 1, id }, null, 2)}\n`);
			await handle.sync();
			return id;
		} catch (error) {
			if (created) {
				await rm(path, { force: true }).catch(() => undefined);
			} else if (hasCode(error, "EEXIST")) {
				const existing = await read();

				if (existing) {
					return existing;
				}
			}

			throw new ChatGPTError("host_identity_invalid", "The ChatGPT host ID could not be saved.", { cause: error });
		} finally {
			await handle?.close().catch(() => undefined);
		}
	});
}

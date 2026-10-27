import { getChatGPTAccessToken, type ChatGPTRequestOptions } from "./auth.js";
import { apiError, ChatGPTError, fetchRemote, isObject, jsonResponse } from "./errors.js";

const MODELS_URL = "https://api.openai.com/v1/models";

export interface ChatGPTModel {
	slug: string;
	displayName: string;
}

export async function listChatGPTModels(options: ChatGPTRequestOptions = {}): Promise<ChatGPTModel[]> {
	const fetchImpl = options.fetch ?? fetch;
	const request = (accessToken: string) =>
		fetchRemote(
			MODELS_URL,
			{
				headers: {
					accept: "application/json",
					authorization: `Bearer ${accessToken}`,
				},
				signal: options.signal,
			},
			fetchImpl,
		);
	const accessToken = await getChatGPTAccessToken(options.authPath, fetchImpl, undefined, options.signal);
	let response = await request(accessToken);

	if (response.status === 401) {
		let refreshError: unknown;

		try {
			const refreshed = await getChatGPTAccessToken(
				options.authPath,
				fetchImpl,
				accessToken,
				options.signal,
			);

			if (refreshed) {
				await response.body?.cancel().catch(() => undefined);
				response = await request(refreshed);
			}
		} catch (error) {
			refreshError = error;
			await response.body?.cancel().catch(() => undefined);
		}

		if (response.status === 401 && refreshError !== undefined) {
			if (refreshError instanceof ChatGPTError) {
				throw refreshError;
			}

			throw new ChatGPTError("refresh_failed", "ChatGPT credentials could not be refreshed.", {
				cause: refreshError,
				retryable: true,
			});
		}
	}

	const body = await jsonResponse(response);

	if (!response.ok) {
		throw apiError(
			body,
			response.status,
			response.headers.get("openai-request-id") ?? response.headers.get("x-request-id"),
			response.headers,
		);
	}

	if (!isObject(body) || !Array.isArray(body.models)) {
		throw new ChatGPTError("invalid_model_catalog", "ChatGPT returned an unexpected model catalog.", {
			retryable: true,
			status: response.status,
		});
	}

	const models: ChatGPTModel[] = [];

	for (const model of body.models) {
		if (!isObject(model) || model.visibility !== "list") {
			continue;
		}

		if (
			typeof model.slug !== "string" ||
			!model.slug.trim() ||
			model.slug.length > 200 ||
			typeof model.display_name !== "string" ||
			!model.display_name.trim() ||
			model.display_name.length > 200
		) {
			throw new ChatGPTError("invalid_model_catalog", "ChatGPT returned an incomplete model listing.", {
				retryable: true,
				status: response.status,
			});
		}

		models.push({
			slug: model.slug,
			displayName: model.display_name,
		});
	}

	return models;
}

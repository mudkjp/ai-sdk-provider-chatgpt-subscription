# AI SDK Provider for ChatGPT Subscription

An [AI SDK](https://ai-sdk.dev) provider that uses a ChatGPT Plus or Pro subscription instead of an OpenAI API key.

It implements OpenAI's [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) flow for open-source apps, including account registration, ID token validation, token refresh, and logout revocation.

## Install

```sh
npm install @mudkipdev/ai-sdk-provider-chatgpt-subscription ai zod
```

## Sign in

```sh
npx @mudkipdev/ai-sdk-provider-chatgpt-subscription login
```

The command opens **Continue with ChatGPT** in your browser and listens on `127.0.0.1:1455` for the callback. It saves credentials to `~/.config/chatgpt-subscription/auth.json` with owner-only permissions.

Useful options:

```sh
chatgpt-subscription login --consent          # show the plan usage consent screen again
chatgpt-subscription login --port 0           # pick any free callback port
chatgpt-subscription login --no-browser       # print the URL without opening a browser
chatgpt-subscription login --auth-path ./work.json
```

`--auth-path` creates a separate account registration. Use one auth file per ChatGPT account. Set `CHATGPT_AUTH_PATH` to point at a specific file or `CHATGPT_CONFIG_DIR` to change the default directory.

```sh
chatgpt-subscription status
chatgpt-subscription models
chatgpt-subscription logout
```

## Usage

```ts
import { streamText } from "ai";
import { createChatGPTProvider } from "@mudkipdev/ai-sdk-provider-chatgpt-subscription";

const chatgpt = createChatGPTProvider();

const result = streamText({
	model: chatgpt("gpt-5"),
	prompt: "Explain why the sky is blue.",
});

for await (const delta of result.textStream) {
	process.stdout.write(delta);
}
```

ChatGPT plan usage always uses streaming on the wire. `streamText` exposes the deltas directly. `generateText` and other non-streaming AI SDK calls work too: the provider buffers the SSE stream and returns the completed response.

```ts
import { generateText } from "ai";

const { text } = await generateText({
	model: chatgpt("gpt-5"),
	prompt: "Explain why the sky is blue.",
});
```

For long outputs, `streamText` avoids buffering the full response in memory.

## Models

```ts
import { listChatGPTModels } from "@mudkipdev/ai-sdk-provider-chatgpt-subscription";

const models = await listChatGPTModels();
```

Each result has a `slug` for the model ID and a `displayName` for UI. The CLI prints the same list:

```sh
chatgpt-subscription models
chatgpt-subscription models --json
```

## How sign-in works

1. The client starts a local callback listener and generates fresh state, nonce, and PKCE values.
2. It opens `https://auth.openai.com/api/accounts/authorize` with `client_id=dynamic_agent_client` on first registration, or with the saved issued client ID on later sign-ins.
3. ChatGPT redirects to `http://127.0.0.1:<port>/auth/callback` with a code and, on first registration, an issued client ID.
4. The code is exchanged at the OpenAI token endpoint. No client secret is used.
5. The ID token is verified against OpenAI's JWKS for signature, issuer, audience, expiry, nonce, and subject.
6. The client ID, verified account identity, tokens, scopes, and expiry are stored locally.
7. Each host gets a stable `urn:uuid:` value in `host.json`, separate from the account file.

`login` on an existing auth file reauthorizes the same registration. It reuses the saved client ID, sends `login_hint` with the saved email, and rejects a callback for a different client or account. Use a different `--auth-path` to add another account.

## Token refresh

Access tokens last one hour. Refresh tokens last 30 days and rotate on every successful refresh.

The provider refreshes shortly before expiry, respects `earliest_refresh_at`, serializes refreshes with a file lock, and writes the rotated token set atomically. Refreshed ID tokens are verified before the new credentials are used. If identity verification is temporarily unavailable, the pending rotation is preserved and retried.

A `401` from the Responses API triggers one forced refresh and retry.

## Sign out

```sh
chatgpt-subscription logout
```

This revokes the refresh token at OpenAI's revocation endpoint, then clears local access, refresh, and ID tokens. The client registration, account identity, and host ID stay saved so the next sign-in can reuse them. If remote revocation cannot be confirmed, local tokens are still cleared and the CLI tells you to disconnect the app in ChatGPT settings.

## Responses API support

The provider targets `POST https://api.openai.com/v1/responses`. Call it as a function or through `.responses()`; `.chat()` is rejected because ChatGPT plan usage does not support the Chat Completions route.

It always enforces the ChatGPT plan usage contract:

- `store` is `false`.
- `stream` is `true`.
- `input` is an array of messages.
- System messages are moved into `instructions`; developer messages stay in `input`.
- Unsupported request fields are removed: `background`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `service_tier`, `temperature`, `top_logprobs`, `top_p`, `truncation`, and `user`.
- Function and custom tools are grouped into an OpenAI tool namespace by default. Set `groupTools` to a string to choose the namespace name, or `false` to disable grouping.
- Image and file inputs work when the selected model accepts them.
- Web search works when the account, workspace, and model allow it.

Unsupported by ChatGPT plan usage, and rejected with a clear error:

- Image generation, file search, Code Interpreter, native computer use, hosted MCP/connectors, tool search, and programmatic tool calling.
- Audio and video input.
- The Files upload API and transcription API.
- `previous_response_id` and `conversation` are rejected. Send the full history in `input`.

Named `tool_choice` cannot be combined with `groupTools`, because tools inside a namespace are not visible to named tool choice. Use `auto`, `required`, or `none`, or disable `groupTools`.

## Errors

Authentication, model listing, and plan usage failures throw `ChatGPTError`:

```ts
import { ChatGPTError } from "@mudkipdev/ai-sdk-provider-chatgpt-subscription";

try {
	const models = await listChatGPTModels();
} catch (error) {
	if (error instanceof ChatGPTError) {
		console.error(error.code, error.retryable, error.requestId);
	}
}
```

Usage-limit errors include a link to [ChatGPT settings -> Usage](https://chatgpt.com/settings/usage). The provider does not retry usage-limit, eligibility, or unsupported-capability errors. Temporary routing failures remain retryable.

## Programmatic API

```ts
import {
	getChatGPTStatus,
	loginChatGPT,
	logoutChatGPT,
} from "@mudkipdev/ai-sdk-provider-chatgpt-subscription";

const result = await loginChatGPT({
	onAuthUrl: (url) => console.log(`Sign in at ${url}`),
	openBrowser: (url) => {
		console.log(url);
	},
});

const status = await getChatGPTStatus();
const { remoteRevoked } = await logoutChatGPT();
```

`loginChatGPT` options:

| Option | Type | Description |
| --- | --- | --- |
| `authPath` | `string` | Credential file path. |
| `appName` | `string` | Display name used only during first registration. |
| `fetch` | `typeof fetch` | Custom fetch used for discovery, token, and JWKS requests. |
| `onAuthUrl` | `(url: string) => void` | Receives the authorization URL. |
| `openBrowser` | `(url: string) => void \| Promise<void>` | Opens the authorization URL. |
| `port` | `number` | Callback port. Defaults to `1455`; `0` chooses any free port. |
| `reconsent` | `boolean` | Adds `prompt=consent` to the authorization request. |
| `signal` | `AbortSignal` | Cancels the pending sign-in. |

## Provider options

| Option | Type | Description |
| --- | --- | --- |
| `authPath` | `string` | Credential file path. Defaults to `$CHATGPT_AUTH_PATH`, `$CHATGPT_CONFIG_DIR/auth.json`, `$XDG_CONFIG_HOME/chatgpt-subscription/auth.json`, or `~/.config/chatgpt-subscription/auth.json`. |
| `fetch` | `typeof fetch` | Custom fetch used for Responses and token refresh requests. |
| `groupTools` | `boolean \| string` | Groups function and custom tools in a namespace. Defaults to `true`; a string sets the namespace name. |
| `refreshOnUnauthorized` | `boolean` | Refreshes once and retries after a `401`. Defaults to `true`. |

## Security

- Credential files are written atomically. Both credential and host files use mode `0600`; the config directory uses `0700`.
- Tokens are never printed by the CLI.
- Authorization URLs contain state, nonce, and PKCE values, but no access or refresh tokens.
- Reauthorization rejects a different account or client ID.
- Treat `auth.json` as a secret. For a VM, complete sign-in locally, transfer the credential file over a secure channel, and let the VM use its own host ID.

## References

- [ChatGPT plan usage for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Examples](https://github.com/openai/sign-in-with-chatgpt-devkit)

## License

MIT. This package is not affiliated with or endorsed by OpenAI.

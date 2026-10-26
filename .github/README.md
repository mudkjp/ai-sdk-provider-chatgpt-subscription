# ai-sdk-provider-chatgpt-subscription

An [AI SDK](https://ai-sdk.dev) provider that uses a ChatGPT Plus or Pro subscription instead of an OpenAI API key.

## Installation

```sh
npm install @mudkipdev/ai-sdk-provider-chatgpt-subscription ai zod
npx @mudkipdev/ai-sdk-provider-chatgpt-subscription login
```

`login` opens the browser and saves credentials to `~/.config/chatgpt-subscription/auth.json`. Use `--no-browser` to print the URL instead, or `--auth-path` to use a different file.

## Usage

```ts
import { streamText } from "ai";
import { createChatGPTProvider } from "@mudkipdev/ai-sdk-provider-chatgpt-subscription";

const chatgpt = createChatGPTProvider();

const result = streamText({
	model: chatgpt("gpt-6.1-sol"),
	prompt: "Explain why the sky is blue.",
});

for await (const delta of result.textStream) {
	process.stdout.write(delta);
}
```

## Is this allowed?

Yes, this uses OpenAI's official [token sharing](https://developers.openai.com/siwc/token-sharing-open-source) feature.
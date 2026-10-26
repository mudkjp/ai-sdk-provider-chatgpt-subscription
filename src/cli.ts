#!/usr/bin/env node
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { getChatGPTStatus, loginChatGPT, logoutChatGPT } from "./auth.js";
import { listChatGPTModels } from "./models.js";
import { chatGPTAuthPath } from "./storage.js";

const HELP = `Usage: chatgpt-subscription <command> [options]

Commands:
  login    Sign in with ChatGPT
  status   Show the saved ChatGPT connection
  models   List models available to the signed-in account
  logout   Revoke the session and remove local tokens

Options:
  --auth-path <path>  Credential file path
  --port <port>       Local sign-in callback port (0 picks any free port)
  --consent           Ask ChatGPT to show the plan usage consent screen again
  --no-browser        Print the sign-in URL without opening a browser
  --json              Print machine-readable JSON for status and models
  -h, --help          Show this help`;

async function openBrowser(url: string): Promise<void> {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
	const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];

	await new Promise<void>((resolve) => {
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.once("error", () => resolve());
		child.once("exit", () => resolve());
		child.unref();
	});
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		options: {
			"auth-path": { type: "string" },
			port: { type: "string" },
			consent: { type: "boolean" },
			"no-browser": { type: "boolean" },
			json: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: true,
	});
	const command = positionals[0] ?? "help";
	const authPath = values["auth-path"] ?? chatGPTAuthPath();

	if (values.help || command === "help") {
		console.log(HELP);
		return;
	}

	if (command === "login") {
		const port = values.port === undefined ? undefined : Number(values.port);

		if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
			throw new Error("--port must be an integer from 0 to 65535.");
		}

		const result = await loginChatGPT({
			authPath,
			port,
			reconsent: values.consent,
			onAuthUrl(url) {
				console.log(`Open this URL to sign in with ChatGPT:\n${url}\n`);
			},
			openBrowser: values["no-browser"] ? undefined : openBrowser,
		});
		const account = result.email ?? result.name ?? "ChatGPT account";
		console.log(`Signed in as ${account}.`);

		if (result.planUsage) {
			console.log("ChatGPT plan usage is enabled.");
		} else {
			console.log("ChatGPT plan usage was not granted.");
			console.log("Run `chatgpt-subscription login --consent` and allow plan usage to enable it.");
		}

		console.log(`Credentials saved to ${result.authPath}.`);
		return;
	}

	if (command === "status") {
		const status = await getChatGPTStatus(authPath);

		if (values.json) {
			console.log(JSON.stringify(status, null, 2));
		} else if (!status.signedIn) {
			console.log(`Not signed in. No active credential at ${status.authPath}.`);
		} else {
			console.log(`Account: ${status.email ?? status.name ?? status.subject ?? "unknown"}`);
			console.log(`Plan usage: ${status.planUsage ? "enabled" : "disabled"}`);
			console.log(`Credential: ${status.authPath}`);

			if (status.clientId) {
				console.log(`Client: ${status.clientId}`);
			}

			if (status.expiresAt) {
				console.log(`Expires: ${new Date(status.expiresAt).toISOString()}`);
			}

			if (status.reauthRequired) {
				console.log("Sign-in required.");
			}
		}

		if (!status.signedIn) {
			process.exitCode = 1;
		}

		return;
	}

	if (command === "models") {
		const models = await listChatGPTModels({ authPath });

		if (values.json) {
			console.log(JSON.stringify(models, null, 2));
		} else {
			for (const model of models) {
				console.log(`${model.slug}\t${model.displayName}`);
			}
		}

		return;
	}

	if (command === "logout") {
		const result = await logoutChatGPT({ authPath });
		console.log(`Removed local ChatGPT tokens from ${result.authPath}.`);

		if (!result.remoteRevoked) {
			console.log("Remote revocation could not be confirmed. Disconnect the app in ChatGPT settings if needed.");
		}

		return;
	}

	throw new Error(`Unknown command: ${command}`);
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

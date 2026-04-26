import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { request } from "undici";
import { normalizeBaseUrl } from "./config.js";

export interface AppValidationResult {
	ok: true;
	url: string;
	title: string;
	textSample: string;
	consoleErrors: string[];
	screenshotPath?: string;
}

export class AppTargetError extends Error {
	diagnosticsPath?: string;
	screenshotPath?: string;

	constructor(message: string, opts: { diagnosticsPath?: string; screenshotPath?: string } = {}) {
		super(message);
		this.name = "AppTargetError";
		this.diagnosticsPath = opts.diagnosticsPath;
		this.screenshotPath = opts.screenshotPath;
	}
}

async function assertHttpReachable(url: string): Promise<void> {
	try {
		const res = await request(url, { method: "GET", bodyTimeout: 5000, headersTimeout: 5000 });
		res.body.dump();
		if (res.statusCode < 200 || res.statusCode >= 400) {
			throw new Error(`HTTP ${res.statusCode}`);
		}
	} catch (err) {
		throw new Error(
			`APP_BASE_URL unreachable at ${url}. Start the app server first, or set APP_BASE_URL to the running app. ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function writeDiagnostics(path: string | undefined, data: Record<string, unknown>): string | undefined {
	if (!path) return undefined;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, 2));
	return path;
}

export async function validateAppTarget(opts: {
	baseUrl?: string;
	diagnosticsPath?: string;
	screenshotPath?: string;
	timeoutMs?: number;
} = {}): Promise<AppValidationResult> {
	const url = normalizeBaseUrl(opts.baseUrl ?? process.env.APP_BASE_URL);
	const timeoutMs = opts.timeoutMs ?? 12_000;
	try {
		await assertHttpReachable(url);
	} catch (err) {
		const diagnosticsPath = writeDiagnostics(opts.diagnosticsPath, {
			ok: false,
			url,
			error: err instanceof Error ? err.message : String(err),
			checkedAt: new Date().toISOString(),
		});
		throw new AppTargetError(err instanceof Error ? err.message : String(err), { diagnosticsPath });
	}

	const { chromium } = await import("playwright");
	const consoleErrors: string[] = [];
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	page.on("pageerror", (err) => consoleErrors.push(err.message));

	try {
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
		await page.waitForFunction(
			() => {
				const text = document.body?.innerText?.trim() ?? "";
				const root = document.querySelector("#root");
				return text.length > 20 || (root?.children.length ?? 0) > 0;
			},
			undefined,
			{ timeout: timeoutMs },
		);
		await page.waitForTimeout(500);

		const [title, textSample] = await Promise.all([
			page.title(),
			page.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 500)),
		]);
		const screenshotPath = opts.screenshotPath;
		if (screenshotPath) {
			mkdirSync(dirname(screenshotPath), { recursive: true });
			await page.screenshot({ path: screenshotPath, fullPage: false });
		}
		writeDiagnostics(opts.diagnosticsPath, {
			ok: true,
			url,
			title,
			textSample,
			consoleErrors,
			screenshotPath,
			checkedAt: new Date().toISOString(),
		});
		return { ok: true, url, title, textSample, consoleErrors, screenshotPath };
	} catch (err) {
		const screenshotPath =
			opts.screenshotPath ??
			(opts.diagnosticsPath
				? resolve(dirname(opts.diagnosticsPath), "app-target-failure.png")
				: undefined);
		if (screenshotPath) {
			mkdirSync(dirname(screenshotPath), { recursive: true });
			await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => undefined);
		}
		const diagnosticsPath = writeDiagnostics(opts.diagnosticsPath, {
			ok: false,
			url,
			error: err instanceof Error ? err.message : String(err),
			consoleErrors,
			screenshotPath,
			checkedAt: new Date().toISOString(),
		});
		throw new AppTargetError(
			`APP_BASE_URL loaded but did not render usable app content at ${url}: ${err instanceof Error ? err.message : String(err)}`,
			{ diagnosticsPath, screenshotPath },
		);
	} finally {
		await page.close().catch(() => undefined);
		await browser.close().catch(() => undefined);
	}
}

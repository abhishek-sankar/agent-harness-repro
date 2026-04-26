import { writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "undici";
import { spawnSync } from "node:child_process";

const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

export interface AudioProbe {
	durationMs: number;
	byteSize: number;
	meanVolumeDb?: number;
	maxVolumeDb?: number;
}

export interface NarrateResult {
	sceneId: string;
	audioPath: string;
	durationMs: number;
	usedFallback: boolean;
	reason?: string;
	voiceId: string;
	modelId: string;
	probe: AudioProbe;
}

function probeDurationMs(audioPath: string): number {
	const out = spawnSync("ffprobe", [
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1",
		audioPath,
	], { encoding: "utf8" });
	if (out.status !== 0) return 0;
	const secs = parseFloat(out.stdout.trim());
	if (!isFinite(secs)) return 0;
	return Math.round(secs * 1000);
}

export function probeAudio(audioPath: string): AudioProbe {
	const durationMs = probeDurationMs(audioPath);
	const byteSize = existsSync(audioPath) ? statSync(audioPath).size : 0;
	const vol = spawnSync("ffmpeg", [
		"-hide_banner",
		"-i", audioPath,
		"-af", "volumedetect",
		"-f", "null",
		"-",
	], { encoding: "utf8" });
	const text = `${vol.stdout ?? ""}\n${vol.stderr ?? ""}`;
	const mean = text.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
	const max = text.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/);
	return {
		durationMs,
		byteSize,
		meanVolumeDb: mean ? Number(mean[1]) : undefined,
		maxVolumeDb: max ? Number(max[1]) : undefined,
	};
}

function writeSilentMp3(audioPath: string, durationMs: number): void {
	mkdirSync(dirname(audioPath), { recursive: true });
	const secs = Math.max(1, Math.round(durationMs / 1000));
	spawnSync("ffmpeg", [
		"-y",
		"-f", "lavfi",
		"-i", `anullsrc=r=44100:cl=mono`,
		"-t", String(secs),
		"-q:a", "9",
		"-acodec", "libmp3lame",
		audioPath,
	], { stdio: "ignore" });
}

function writeSystemSpeechMp3(audioPath: string, text: string, durationMs: number): { ok: boolean; reason?: string } {
	const say = spawnSync("which", ["say"], { encoding: "utf8" });
	if (say.status !== 0) {
		writeSilentMp3(audioPath, durationMs);
		return { ok: false, reason: "macOS say command not available; using silent fallback." };
	}
	mkdirSync(dirname(audioPath), { recursive: true });
	const aiff = `${audioPath}.aiff`;
	const spoken = spawnSync("say", ["-v", process.env.RETURN_BRIEF_SYSTEM_VOICE ?? "Samantha", "-o", aiff, text], {
		stdio: "ignore",
	});
	if (spoken.status !== 0) {
		writeSilentMp3(audioPath, durationMs);
		return { ok: false, reason: "macOS say command failed; using silent fallback." };
	}
	const converted = spawnSync("ffmpeg", [
		"-y",
		"-i", aiff,
		"-codec:a", "libmp3lame",
		"-q:a", "4",
		audioPath,
	], { stdio: "ignore" });
	try {
		unlinkSync(aiff);
	} catch {
		// Best-effort temp cleanup.
	}
	if (converted.status !== 0) {
		writeSilentMp3(audioPath, durationMs);
		return { ok: false, reason: "ffmpeg conversion of system speech failed; using silent fallback." };
	}
	return { ok: true };
}

function writeFallbackMp3(audioPath: string, text: string, durationMs: number): { ok: boolean; reason?: string } {
	const allowSystemSpeech = process.env.RETURN_BRIEF_ENABLE_SYSTEM_TTS === "1";
	if (allowSystemSpeech) {
		return writeSystemSpeechMp3(audioPath, text, durationMs);
	}
	writeSilentMp3(audioPath, durationMs);
	return {
		ok: true,
		reason: "ElevenLabs unavailable; using deterministic silent fallback with captions.",
	};
}

export async function narrateScene(opts: {
	sceneId: string;
	text: string;
	audioPath: string;
	voiceId?: string;
	durationHintMs: number;
}): Promise<NarrateResult> {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	const voiceId = opts.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID;
	const modelId = process.env.ELEVENLABS_MODEL_ID ?? DEFAULT_MODEL_ID;
	const allowFallback = process.env.RETURN_BRIEF_ALLOW_TTS_FALLBACK === "1";

	if (!apiKey) {
		const fallback = writeFallbackMp3(opts.audioPath, opts.text, opts.durationHintMs);
		const probe = probeAudio(opts.audioPath);
		return {
			sceneId: opts.sceneId,
			audioPath: opts.audioPath,
			durationMs: probe.durationMs || opts.durationHintMs,
			usedFallback: true,
			reason: fallback.ok
				? fallback.reason ?? "ELEVENLABS_API_KEY not set; using deterministic silent fallback with captions."
				: `ELEVENLABS_API_KEY not set; ${fallback.reason}`,
			voiceId,
			modelId,
			probe,
		};
	}

	try {
		const res = await request(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
			method: "POST",
			headers: {
				"xi-api-key": apiKey,
				"content-type": "application/json",
				accept: "audio/mpeg",
			},
			body: JSON.stringify({
				text: opts.text,
				model_id: modelId,
				voice_settings: { stability: 0.5, similarity_boost: 0.7 },
			}),
		});
		if (res.statusCode < 200 || res.statusCode >= 300) {
			const body = await res.body.text();
			throw new Error(`ElevenLabs ${res.statusCode}: ${body.slice(0, 200)}`);
		}
		const buf = Buffer.from(await res.body.arrayBuffer());
		mkdirSync(dirname(opts.audioPath), { recursive: true });
		writeFileSync(opts.audioPath, buf);
		const probe = probeAudio(opts.audioPath);
		const durationMs = probe.durationMs || opts.durationHintMs;
		if (probe.maxVolumeDb !== undefined && probe.maxVolumeDb <= -80) {
			throw new Error(`ElevenLabs returned effectively silent audio (max_volume ${probe.maxVolumeDb} dB)`);
		}
		return {
			sceneId: opts.sceneId,
			audioPath: opts.audioPath,
			durationMs,
			usedFallback: false,
			voiceId,
			modelId,
			probe,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!allowFallback) {
			throw new Error(
				`ElevenLabs narration failed for ${opts.sceneId}: ${message}. Set RETURN_BRIEF_ALLOW_TTS_FALLBACK=1 to allow deterministic fallback audio.`,
			);
		}
		const fallback = writeFallbackMp3(opts.audioPath, opts.text, opts.durationHintMs);
		const probe = probeAudio(opts.audioPath);
		if (!fallback.ok || (probe.maxVolumeDb !== undefined && probe.maxVolumeDb <= -80)) {
			throw new Error(
				`ElevenLabs narration failed for ${opts.sceneId}: ${message}; fallback narration was unavailable or silent: ${fallback.reason ?? `max_volume ${probe.maxVolumeDb} dB`}`,
			);
		}
		return {
			sceneId: opts.sceneId,
			audioPath: opts.audioPath,
			durationMs: probe.durationMs || opts.durationHintMs,
			usedFallback: true,
			reason: fallback.ok
				? `ElevenLabs call failed: ${message}; ${fallback.reason ?? "using deterministic silent fallback with captions."}`
				: `ElevenLabs call failed: ${message}; ${fallback.reason}`,
			voiceId,
			modelId,
			probe,
		};
	}
}

export function ensureAudio(audioPath: string, durationHintMs: number): number {
	if (existsSync(audioPath) && statSync(audioPath).size > 0) {
		const probe = probeAudio(audioPath);
		if (
			process.env.ELEVENLABS_API_KEY &&
			process.env.RETURN_BRIEF_ALLOW_TTS_FALLBACK !== "1" &&
			probe.maxVolumeDb !== undefined &&
			probe.maxVolumeDb <= -80
		) {
			throw new Error(`Refusing to compose silent audio at ${audioPath} (max_volume ${probe.maxVolumeDb} dB)`);
		}
		return probe.durationMs || durationHintMs;
	}
	if (process.env.ELEVENLABS_API_KEY && process.env.RETURN_BRIEF_ALLOW_TTS_FALLBACK !== "1") {
		throw new Error(`Missing narration audio at ${audioPath}`);
	}
	writeSilentMp3(audioPath, durationHintMs);
	return probeDurationMs(audioPath) || durationHintMs;
}

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ArtifactKind, ArtifactRecord } from "./types.js";

export interface StoredArtifact {
	id: string;
	kind: ArtifactKind;
	storageKey: string;
	mimeType: string;
	sizeBytes: number;
	checksum: string;
}

export type ArtifactDownload =
	| { type: "redirect"; url: string }
	| { type: "file"; path: string; mimeType: string };

export interface ArtifactStore {
	putFile(runId: string, kind: ArtifactKind, filePath: string, mimeType: string): Promise<StoredArtifact>;
	getDownload(artifact: ArtifactRecord): Promise<ArtifactDownload>;
}

async function sha256(filePath: string): Promise<string> {
	const buffer = await readFile(filePath);
	return createHash("sha256").update(buffer).digest("hex");
}

export class LocalArtifactStore implements ArtifactStore {
	constructor(private readonly baseDir: string) {}

	async putFile(runId: string, kind: ArtifactKind, filePath: string, mimeType: string): Promise<StoredArtifact> {
		const id = randomUUID();
		const storageKey = join("runs", runId, `${kind}-${id}${extensionForMime(mimeType)}`);
		const destination = join(this.baseDir, storageKey);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(filePath, destination);
		const checksum = await sha256(destination);
		const sizeBytes = (await readFile(destination)).byteLength;
		return { id, kind, storageKey, mimeType, sizeBytes, checksum };
	}

	async getDownload(artifact: ArtifactRecord): Promise<ArtifactDownload> {
		return {
			type: "file",
			path: join(this.baseDir, artifact.storageKey),
			mimeType: artifact.mimeType,
		};
	}
}

export class S3ArtifactStore implements ArtifactStore {
	private readonly client: S3Client;

	constructor(
		private readonly bucket: string,
		region: string,
		endpoint?: string,
	) {
		this.client = new S3Client({
			region,
			endpoint,
			forcePathStyle: !!endpoint,
		});
	}

	async putFile(runId: string, kind: ArtifactKind, filePath: string, mimeType: string): Promise<StoredArtifact> {
		const id = randomUUID();
		const storageKey = `runs/${runId}/${kind}-${id}${extensionForMime(mimeType)}`;
		const body = await readFile(filePath);
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: storageKey,
				Body: body,
				ContentType: mimeType,
			}),
		);
		return {
			id,
			kind,
			storageKey,
			mimeType,
			sizeBytes: body.byteLength,
			checksum: createHash("sha256").update(body).digest("hex"),
		};
	}

	async getDownload(artifact: ArtifactRecord): Promise<ArtifactDownload> {
		const url = await getSignedUrl(
			this.client,
			new GetObjectCommand({
				Bucket: this.bucket,
				Key: artifact.storageKey,
				ResponseContentType: artifact.mimeType,
			}),
			{ expiresIn: 900 },
		);
		return { type: "redirect", url };
	}
}

function extensionForMime(mimeType: string): string {
	switch (mimeType) {
		case "video/mp4":
			return ".mp4";
		case "application/json":
			return ".json";
		case "text/markdown":
			return ".md";
		case "image/png":
			return ".png";
		default:
			return "";
	}
}


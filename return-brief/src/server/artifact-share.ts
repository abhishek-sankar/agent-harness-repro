import { createHmac, timingSafeEqual } from "node:crypto";

function sign(artifactId: string, secret: string): Buffer {
	return createHmac("sha256", secret).update(artifactId).digest();
}

export function createArtifactShareToken(artifactId: string, secret: string): string {
	return sign(artifactId, secret).toString("hex");
}

export function verifyArtifactShareToken(artifactId: string, token: string | undefined, secret: string): boolean {
	if (!token) return false;
	try {
		const expected = sign(artifactId, secret);
		const actual = Buffer.from(token, "hex");
		if (actual.length !== expected.length) return false;
		return timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

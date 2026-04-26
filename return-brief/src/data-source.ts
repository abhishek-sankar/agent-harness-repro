import type { RepoSnapshot } from "./types.js";

export async function loadSnapshot(repo: string): Promise<RepoSnapshot> {
	console.log(`   [github] fetching live data for ${repo}${process.env.GITHUB_TOKEN ? "" : " without a token"}`);
	const { fetchSnapshot } = await import("./github.js");
	return fetchSnapshot(repo);
}

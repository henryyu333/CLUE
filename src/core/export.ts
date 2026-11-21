import type { ClueConfig, CluePaths } from "./config.ts";
import { formatIntentCard, getProjectIntent } from "./intents.ts";
import { listActive, type DecisionRow, type NoteRow, type PitfallRow } from "./ledger.ts";
import { readHotMemoryView } from "./markdown.ts";
import { redactSecrets } from "./security.ts";

export interface WebExportBundle {
	projectKey: string | null;
	generatedAt: string;
	charCount: number;
	text: string;
}

/**
 * Generates a compact, secret-scrubbed plain-text context pack ready to paste into web chat tools
 * (e.g. Gemini / ChatGPT) so cloud chats understand your local setup, taste, and active project intent.
 */
export function buildWebExportBundle(
	config: ClueConfig,
	paths: CluePaths,
	projectKey: string | null,
): WebExportBundle {
	const view = readHotMemoryView(config, paths, projectKey);
	const intentCard = getProjectIntent(paths.intentsPath, projectKey);
	const decisions = listActive<DecisionRow>(paths, "decision", projectKey).slice(0, 8);
	const pitfalls = listActive<PitfallRow>(paths, "pitfall", projectKey).slice(0, 6);
	const notes = listActive<NoteRow>(paths, "note", projectKey).slice(0, 10);

	const parts: string[] = [
		`# Local Context Snapshot (project: ${projectKey ?? "general"})`,
		"Below is a compact snapshot of my local environment, preferences, and current project context for reference:",
	];

	if (view.profileRaw.trim()) {
		parts.push(`## Background & Taste\n${view.profileRaw.trim()}`);
	}
	if (intentCard) {
		parts.push(`## Active Project Intent (${intentCard.project})\n${formatIntentCard(intentCard)}`);
	}
	if (view.scoped.text) {
		parts.push(`## Project Notes\n${view.scoped.text}`);
	}
	if (decisions.length > 0) {
		parts.push(
			"## Key Decisions\n" +
				decisions
					.map(
						d =>
							`- [${d.project}] ${d.decision} (原因: ${d.rationale}${d.revisit_when ? `；推翻条件: ${d.revisit_when}` : ""})`,
					)
					.join("\n"),
		);
	}
	if (pitfalls.length > 0) {
		parts.push(
			"## Known Pitfalls (Root Causes)\n" +
				pitfalls.map(p => `- [${p.project}] ${p.symptom} -> ${p.root_cause}`).join("\n"),
		);
	}
	if (notes.length > 0) {
		parts.push(`## Personal Notes\n${notes.map(n => `- [${n.project}] ${n.content}`).join("\n")}`);
	}

	const scrubbed = redactSecrets(parts.join("\n\n"));
	return {
		projectKey,
		generatedAt: new Date().toISOString(),
		charCount: [...scrubbed].length,
		text: scrubbed,
	};
}

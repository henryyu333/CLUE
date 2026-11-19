export interface SecurityScanResult {
	ok: boolean;
	reason?: string;
	rule?: string;
}

interface SecurityRule {
	name: string;
	pattern: RegExp;
	message: string;
}

const SECRET_RULES: readonly SecurityRule[] = [
	{
		name: "private-key-block",
		pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
		message: "检测到私钥 PEM 块，禁止写入个人记忆。",
	},
	{
		name: "openai-anthropic-key",
		pattern: /\b(?:sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,})\b/,
		message: "检测到疑似 OpenAI / Anthropic / Stripe API Key，禁止写入个人记忆。",
	},
	{
		name: "github-token",
		pattern: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|gho_[A-Za-z0-9]{30,})\b/,
		message: "检测到疑似 GitHub Token，禁止写入个人记忆。",
	},
	{
		name: "aws-access-key",
		pattern: /\bAKIA[0-9A-Z]{16}\b/,
		message: "检测到疑似 AWS Access Key，禁止写入个人记忆。",
	},
	{
		name: "google-api-key",
		pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
		message: "检测到疑似 Google API Key，禁止写入个人记忆。",
	},
	{
		name: "bearer-or-jwt",
		pattern: /\b(?:Bearer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/,
		message: "检测到疑似 Bearer Token 或 JWT 凭据，禁止写入个人记忆。",
	},
	{
		name: "explicit-secret-assignment",
		pattern: /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_/+=-]{12,}["']?/i,
		message: "检测到疑似明文密钥或密码赋值，禁止写入个人记忆（如需提及，请只记录环境变量名）。",
	},
];

const INJECTION_RULES: readonly SecurityRule[] = [
	{
		name: "prompt-injection-ignore",
		pattern: /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system)\s+(?:instructions|prompts|rules)\b/i,
		message: "检测到疑似 Prompt 注入指令，已拦截写入。",
	},
	{
		name: "prompt-injection-xml-tag",
		pattern: /<\/?(?:system|system_instruction|developer|user_rules|clue-memory)\b/i,
		message: "记忆正文禁止包含系统提示词边界标签。",
	},
];

export function scanMemoryContent(text: string): SecurityScanResult {
	if (!text) return { ok: true };
	for (const rule of SECRET_RULES) {
		if (rule.pattern.test(text)) {
			return { ok: false, rule: rule.name, reason: rule.message };
		}
	}
	for (const rule of INJECTION_RULES) {
		if (rule.pattern.test(text)) {
			return { ok: false, rule: rule.name, reason: rule.message };
		}
	}
	return { ok: true };
}

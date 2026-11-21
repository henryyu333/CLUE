export interface IntentSignals {
	isStart: boolean;
	isWrapUp: boolean;
	isCasualClose: boolean;
	isExplicitMemoryEdit: boolean;
	isDream: boolean;
}

/**
 * Deliberately loose keyword detection. Every notice triggered here is phrased conditionally
 * ("if the user is actually asking to ..."), so the model — not a regex — decides intent.
 * A false positive costs a few hidden lines; a false negative silently skips memory work.
 */

const WRAP_RE = /收尾|收工|\bwrap(?:\s*|-)up\b/i;
const START_RE = /开工|\bkick\s*off\b|\bstart\s+work\b/i;
const DREAM_RE = /做梦整理|记忆体检|体检(?:一下)?(?:个人)?记忆|(?:深度)?整理(?:一下)?(?:个人)?记忆|clue\s+dream/i;
const MEMORY_EDIT_RE =
	/记住|记下|记一下|记进|写进记忆|写入记忆|存进记忆|更新记忆|改(?:一下)?记忆|删(?:掉|除)?.{0,8}记忆|忘掉|撤回记忆|回滚记忆|\bremember\b|\bforget\b|clue\s+(?:undo|apply)/i;
const CASUAL_CLOSE_RE =
	/没事了|没别的事了|先这样|就这样吧?|可以了|行了|搞定了?谢谢|今天就到这|先到这|没问题了|that'?s all|all good|nothing else/i;
const CONTINUATION_RE = /帮我|请|继续|接下来|然后|顺便|还有|另外|改一下|修一下|查一下|看看|怎么|为什么|能不能|要不要|[?？]/;
const NEGATED_RE = /(?:不用|不要|不必|无需|不需要|别|先别|暂不|暂时不)\s*(?:收尾|收工|开工|整理记忆|记住|写入记忆)/;

/** Strip code and short quoted mentions so citing a keyword ("聊聊「收尾」") is not a command. */
function sanitizeForIntent(rawPrompt: string): string {
	return rawPrompt
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/~~~[\s\S]*?~~~/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/[「『“][^」』”]{1,24}[」』”]/g, " ")
		.replace(/["'][^"']{1,24}["']/g, " ")
		.trim();
}

export function classifyPromptIntent(rawPrompt: string): IntentSignals {
	const text = sanitizeForIntent(rawPrompt);
	const none = { isStart: false, isWrapUp: false, isCasualClose: false, isExplicitMemoryEdit: false, isDream: false };
	if (!text || NEGATED_RE.test(text)) return none;
	const compactLen = [...text.replace(/[\s，。！？,.!~～:：;；]+/g, "")].length;
	const isWrapUp = WRAP_RE.test(text);
	const isDream = DREAM_RE.test(text);
	return {
		isStart: START_RE.test(text),
		isWrapUp,
		isDream,
		isExplicitMemoryEdit: MEMORY_EDIT_RE.test(text),
		isCasualClose:
			!isWrapUp && !isDream && compactLen <= 28 && CASUAL_CLOSE_RE.test(text) && !CONTINUATION_RE.test(text),
	};
}

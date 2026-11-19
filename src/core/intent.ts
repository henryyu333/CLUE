export interface IntentSignals {
	isStart: boolean;
	isWrapUp: boolean;
	isCasualClose: boolean;
	isExplicitMemoryEdit: boolean;
	isDream: boolean;
}

const CONTINUATION_CUES =
	/(?:帮我|请|继续|接下来|再|然后|顺便|还有|另外|改一下|修一下|查一下|看看|写一个|加一个|怎么|为什么|能不能|要不要|是否|吗[？?]?$|\?|？)/;

const CASUAL_CLOSE_RE =
	/(?:没事了|没别的事了|先这样|就这样吧?|好了先这样|可以了|行了先这样|搞定了?谢谢|谢谢没事了|今天就到这|先到这吧?|结束吧?|没问题了谢谢|行，?先这样|好，?没事了)/;

export function classifyPromptIntent(rawPrompt: string): IntentSignals {
	// Strip fenced code blocks and inline code so code literals never trigger workflow rituals
	const stripped = rawPrompt
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/~~~[\s\S]*?~~~/g, " ")
		.replace(/`[^`]*`/g, " ")
		.trim();

	if (!stripped) {
		return {
			isStart: false,
			isWrapUp: false,
			isCasualClose: false,
			isExplicitMemoryEdit: false,
			isDream: false,
		};
	}

	const negated = /(?:不用|不要|不必|无需|不需要|别|先别)(?:收尾|收工|开工|整理记忆|体检记忆|做梦)/.test(stripped);
	// Ignore meta-discussion or questions talking ABOUT the keywords ("什么开工收尾都不会影响...对吗？")
	const isQuestionOrMeta =
		/(?:[?？]$|(?:对吗|是吗|行吗|好吗|可以吗|会冲突吗|不影响吗|怎么用|什么时候用|什么时候启用|是什么|干什么用)[？?。!]?$|(?:不会影响|不冲突|什么开工收尾|开工收尾|开工\/收尾|开工和收尾|了解一下|解释一下))/.test(
			stripped,
		);
	const isStart = !negated && !isQuestionOrMeta && /开工(?:吧|了|啦|哈|呀|啊)?/.test(stripped);
	const isWrapUp = !negated && !isQuestionOrMeta && /(?:收尾|收工)(?:吧|了|啦|哈|呀|啊)?/.test(stripped);
	const isDream =
		!negated &&
		!isQuestionOrMeta &&
		/(?:clue\s+dream|做梦整理|体检.*记忆|记忆体检|整理.*个人记忆|全面整理记忆|深度整理记忆)/i.test(stripped);
	const isExplicitMemoryEdit =
		/(?:记住|记进记忆|写入记忆|存进记忆|更新记忆|删掉.*记忆|删除.*记忆|修改.*记忆|回滚.*记忆|把这个坑记|记一下这个坑|记下这个偏好|记到\s*clue|写入\s*clue)/i.test(
			stripped,
		);

	// Casual close only triggers on short closing utterances without follow-up requests
	const compact = stripped.replace(/[\s，。！？,.!~～]+/g, "");
	const isCasualClose =
		!negated &&
		!isWrapUp &&
		!isStart &&
		!isDream &&
		!isExplicitMemoryEdit &&
		[...compact].length <= 28 &&
		CASUAL_CLOSE_RE.test(stripped) &&
		!CONTINUATION_CUES.test(stripped);

	return { isStart, isWrapUp, isCasualClose, isExplicitMemoryEdit, isDream };
}

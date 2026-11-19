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
	/(?:没事了|没别的事了|先这样|就这样吧?|好了先这样|可以了|行了先这样|搞定了?谢谢|谢谢没事了|今天就到这|先到这吧?|结束吧?|没问题了谢谢|行，?先这样|好，?没事了|that'?s all(?: for now)?|all good(?:,? thanks)?|nothing else)/i;

// Questions or meta-discussions talking ABOUT hooks/rituals/memory rather than issuing a command
const QUESTION_OR_META_RE =
	/(?:[?？]\s*$|(?:对吗|是吗|行吗|好吗|可以吗|会冲突吗|不影响吗|怎么用|什么时候用|什么时候启用|是什么|干什么用|原理是什么|有啥区别|有什么区别)[？?。!！]?\s*$|(?:不会影响|不冲突|什么开工收尾|开工收尾|开工\/收尾|开工和收尾|了解一下|解释一下|介绍一下|讲一下|说说.*怎么|how\s+does|what\s+is|when\s+(?:should|to)\s+(?:i\s+)?use|explain\s+))/i;

const NEGATED_RE =
	/(?:不用|不要|不必|无需|不需要|别|先别|暂不|暂时不)\s*(?:收尾|收工|开工|整理记忆|体检记忆|做梦|clue\s+dream|记住|写入记忆)/i;

/**
 * Strip code blocks, inline code, and quoted mentions so talking ABOUT a keyword
 * (e.g. "聊聊「开工」和「收尾」") never fires a workflow ritual.
 */
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
	const stripped = sanitizeForIntent(rawPrompt);
	if (!stripped) {
		return {
			isStart: false,
			isWrapUp: false,
			isCasualClose: false,
			isExplicitMemoryEdit: false,
			isDream: false,
		};
	}

	const negated = NEGATED_RE.test(stripped);
	const isQuestionOrMeta = QUESTION_OR_META_RE.test(stripped);
	const compactLen = [...stripped.replace(/[\s，。！？,.!~～:：;；]+/g, "")].length;

	// 1) Start ritual: must appear as an imperative clause opener (not buried inside a discussion)
	const isStart =
		!negated &&
		!isQuestionOrMeta &&
		(/(?:^|[，。！？\n；;]\s*)(?:那(?:我们|就)?|现在|开始|准备)?\s*开工(?:吧|了|啦|哈|呀|啊)?(?:$|[，。！？\s：:；;])/.test(
			stripped,
		) ||
			(compactLen <= 40 && /^(?:let'?s\s+)?(?:kick\s*off|start\s+work)\b/i.test(stripped)));

	// 2) Wrap-up ritual: imperative closing clause, never triggered on meta-discussion or long unrelated paragraphs
	const isWrapUp =
		!negated &&
		!isQuestionOrMeta &&
		(/(?:^|[，。！？\n；;]\s*)(?:(?:那|好了|行了?|可以了?|今天就?|今天先|咱们|我们|帮我|请)\s*)?(?:(?:做完|弄完|搞完|搞定|处理完|解决完|跑完|测完|发完|改完|修完|合入|合完|推完|部署完)(?:这些|这步|这个|之后|以后|后|版|新版本)?\s*)?(?:(?:然后|接着|顺便|最后)\s*)?(?:就|再|先|直接|准备|可以|开始)?\s*(?:收尾|收工)(?:吧|了|啦|哈|呀|啊)?(?:$|[，。！？\s：:；;])/.test(
			stripped,
		) ||
			(compactLen <= 40 && /^(?:please\s+)?(?:let'?s\s+)?wrap\s*up\b/i.test(stripped)));

	// 3) Dream audit: require either a short standalone command OR an explicit imperative verb before the phrase
	const isDream =
		!negated &&
		!isQuestionOrMeta &&
		((compactLen <= 18 && /^(?:clue\s+dream|做梦整理|记忆体检|体检记忆|深度整理记忆)$/i.test(stripped)) ||
			/(?:帮我|请|现在|来一次|做一次|执行|运行|跑一下|启动|开始)\s*(?:一次\s*)?(?:clue\s+dream|做梦整理|体检(?:一下)?(?:个人)?记忆|记忆体检|深度整理(?:个人)?记忆|整理(?:一下)?(?:个人)?记忆)/i.test(
				stripped,
			) ||
			/^run\s+clue\s+dream\b/i.test(stripped));

	// 4) Explicit memory edit: imperative command to remember/update/remove/undo
	const isExplicitMemoryEdit =
		!negated &&
		!isQuestionOrMeta &&
		/(?:(?:帮我|请|直接)?(?:记住|记进记忆|写入记忆|存进记忆|更新记忆|删掉.{0,12}记忆|删除.{0,12}记忆|修改.{0,12}记忆|回滚.{0,12}记忆|把这个坑记|记一下这个坑|记下这个偏好|记到\s*clue|写入\s*clue)|^(?:please\s+)?(?:remember\s+that|save\s+to\s+clue|forget\s+from\s+clue)\b)/i.test(
			stripped,
		);

	// 5) Casual close: short closing utterance without follow-up requests
	const isCasualClose =
		!negated &&
		!isQuestionOrMeta &&
		!isWrapUp &&
		!isStart &&
		!isDream &&
		!isExplicitMemoryEdit &&
		compactLen <= 28 &&
		CASUAL_CLOSE_RE.test(stripped) &&
		!CONTINUATION_CUES.test(stripped);

	return { isStart, isWrapUp, isCasualClose, isExplicitMemoryEdit, isDream };
}

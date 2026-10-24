/**
 * dsh-throwtomatoes-plugin — host half.
 *
 * The browser half owns the tomato key and its effects. This half is the only
 * place that can reach into a running agent: it exposes one same-origin HTTP
 * endpoint that turns a tomato press into an invisible runtime-context message
 * (queued after the current turn, or after interrupting it), so the user never
 * sees a synthetic "user message" appear in the conversation.
 */

import { randomUUID } from 'node:crypto';

export const name = 'dsh-throwtomatoes-plugin';

export const inject = ['webServer'];

/** Prefix the browser half posts to. Keep in sync with `lib/client.js`. */
const ROUTE = '/_dsh/throwtomatoes';

/** Hard cap on the request body so a stray client cannot balloon host memory. */
const MAX_BODY_BYTES = 8 * 1024;

/** Source identity the conversation client already knows how to hide. */
const SOURCE_KIND = 'runtime-context';

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('request body too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8').trim();
			if (raw.length === 0) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch (error) {
				reject(error);
			}
		});
		req.on('error', reject);
	});
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(body),
	});
	res.end(body);
}

/**
 * The message the model reads. It is user-role so the model treats it as a
 * directive from the person at the keyboard, but its `runtime-context` source
 * keeps it out of the visible conversation.
 */
function noticeMessage(text, heavy, hits) {
	return {
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text }],
		source: {
			kind: SOURCE_KIND,
			form: 'notice',
			summary: heavy
				? `🍅 连扔 ${hits} 个番茄，已中断当前任务`
				: `🍅 扔了 ${hits} 个番茄`,
		},
	};
}

function lightText(hits) {
	const opening = hits > 1
		? `🍅 用户朝你扔了 ${hits} 个番茄，表示刚才的做法不对。`
		: '🍅 用户朝你扔了一个番茄，表示刚才的做法不对。';
	return `【扔番茄】${opening}

用户对刚才的做法不满意。等当前任务结束后，请按下面的要求做：

1. 先承认错误：明确指出你刚才哪一步做错了、为什么用户会不认可。
2. 深入思考「不该这么做的话，应该怎么做」：在思考过程里完整推演替代方案，包括应当先确认什么、应当改动哪些地方、以及如何避免同样的问题再次出现。
3. 本轮不要修改任何文件，也不要继续原任务，只做反思与方案。
4. 反思完成后，用 ask_user_question 工具把你的替代方案作为选项提问用户，简要说明每个选项的取舍；等用户回答后，再严格按用户的答复继续。

说明：这条消息由用户点击番茄键触发，是系统注入的提醒，不是用户手打的内容。`;
}

function heavyText(hits) {
	return `【扔番茄】🍅 用户怒气冲冲地朝你连扔了 ${hits} 个番茄，并且已经强行中断了刚才的任务。

用户认为刚才的做法明显不对。请立刻停下原有思路，按下面的要求做：

1. 先承认错误：明确指出你刚才哪一步做错了、为什么用户会不认可。
2. 深入思考「不该这么做的话，应该怎么做」：在思考过程里完整推演替代方案，包括应当先确认什么、应当改动哪些地方、以及如何避免同样的问题再次出现。
3. 本轮不要修改任何文件，也不要继续原任务，只做反思与方案。
4. 反思完成后，用 ask_user_question 工具把你的替代方案作为选项提问用户，简要说明每个选项的取舍；等用户回答后，再严格按用户的答复继续。

说明：这条消息由用户点击番茄键触发，是系统注入的提醒，不是用户手打的内容。`;
}

/**
 * Turn one tomato press into host-side agent work.
 * @returns {{ ok: boolean, heavy: boolean, stopped: boolean, error?: string }}
 */
function throwTomato(ctx, { sessionId, hits, heavy }) {
	const agents = ctx.get('agents');
	const agent = agents?.get?.(sessionId);
	if (agent === undefined || agent === null) {
		return { ok: false, heavy, stopped: false, error: 'agent-unavailable' };
	}
	let stopped = false;
	if (heavy && agent.status === 'running') {
		// Same shape as the composer's own stop key, so queued user input survives.
		agent.cancel({ kind: 'user' }, { keepInbox: true });
		stopped = true;
	}
	// `followup` appends to the next turn and wakes the driver: "after the
	// running task ends" for a light throw, "right after the interrupt" for a
	// heavy one.
	agent.followup(noticeMessage(heavy ? heavyText(hits) : lightText(hits), heavy, hits));
	return { ok: true, heavy, stopped };
}

function createHandler(ctx) {
	return async (req, res) => {
		const rawUrl = req.url ?? '/';
		const pathname = rawUrl.split('?')[0];
		if (pathname !== `${ROUTE}/throw`) {
			sendJson(res, 404, { ok: false, error: 'not-found' });
			return;
		}
		if (req.method !== 'POST') {
			sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
			return;
		}
		let body;
		try {
			body = await readJsonBody(req);
		} catch {
			sendJson(res, 400, { ok: false, error: 'bad-json' });
			return;
		}
		const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
		const hits = Number(body.hits);
		if (sessionId.length === 0 || !Number.isFinite(hits) || hits <= 0) {
			sendJson(res, 400, { ok: false, error: 'bad-request' });
			return;
		}
		const heavy = body.heavy === true || hits >= 3;
		try {
			const result = throwTomato(ctx, { sessionId, hits: Math.floor(hits), heavy });
			sendJson(res, result.ok ? 200 : 409, result);
		} catch (error) {
			ctx.logger?.warn?.('[throwtomatoes] failed to deliver the tomato notice', error);
			sendJson(res, 500, { ok: false, heavy, stopped: false, error: 'internal' });
		}
	};
}

export function apply(ctx) {
	const webServer = ctx.get('webServer');
	if (webServer === undefined || typeof webServer.register !== 'function') {
		ctx.logger?.warn?.('[throwtomatoes] webServer is unavailable; tomato delivery is disabled');
		return;
	}
	const registered = webServer.register({ kind: 'prefix', path: ROUTE, handler: createHandler(ctx) });
	if (typeof registered === 'function') {
		ctx.effect(() => registered, 'dsh-throwtomatoes-plugin: route');
	} else if (registered !== undefined && registered !== null && typeof registered.then === 'function') {
		ctx.effect(() => () => { void registered.then((dispose) => dispose?.()); }, 'dsh-throwtomatoes-plugin: route');
	}
}

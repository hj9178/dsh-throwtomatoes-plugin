/**
 * dsh-throwtomatoes-plugin — host half.
 *
 * The browser half owns the tomato key and its effects. This half is the only
 * place that can reach the model request itself: it exposes one same-origin
 * HTTP endpoint, and a tomato press arms a one-shot reminder that is merged
 * into the next LLM request by the `agent/pre-step` waterfall.
 *
 * That path never sends a user prompt and never queues one: the reminder is
 * merged into the next model request by the `agent/pre-step` waterfall. The
 * agent loop commits it as a `user/message` event whose source kind is not
 * `user`, so the browser hides it while the model still receives it. A light
 * throw arms the reminder and lets the current turn finish; a heavy throw
 * interrupts the turn first, then restarts it with the reminder armed.
 */

import { randomUUID } from 'node:crypto';

export const name = 'dsh-throwtomatoes-plugin';

export const inject = ['webServer'];

/** Prefix the browser half posts to. Keep in sync with `lib/client.js`. */
const ROUTE = '/_dsh/throwtomatoes';

/** Hard cap on the request body so a stray client cannot balloon host memory. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * A reminder that was never claimed is dropped after this long.
 *
 * The window has to outlast the running task: a light throw only lets the
 * current turn finish, which can legitimately take minutes, and the reminder is
 * claimed by the step that opens the turn after it. A couple of minutes would
 * quietly drop tomatoes thrown at long tasks.
 */
const ARM_TTL_MS = 30 * 60_000;

/**
 * Source identity of the injected message.
 *
 * It must NOT be `runtime-context`: the agent loop treats that kind specially
 * (it only uses it to trigger the stock runtime-context snapshot and then drops
 * the message, so it never reaches the request). Every other kind is committed
 * as a `user/message` event, which is what puts the reminder into the derived
 * history the model request is built from. The browser hides it anyway: the
 * chat view only renders a non-`user` sourced message when its content carries
 * tool-addition/removal blocks, so the reminder stays invisible to the client.
 */
const SOURCE_KIND = 'dsh-throwtomatoes';

/**
 * Armed reminders, one per agent.
 *
 * A `WeakMap` keyed by the agent means a reminder can never leak into another
 * conversation and disappears with the agent it belongs to.
 *
 * @type {WeakMap<object, { text: string, summary: string, armedAt: number }>}
 */
const armed = new WeakMap();

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		const timer = setTimeout(() => {
			settle(reject, Object.assign(new Error('body read timed out'), { status: 408 }));
			req.destroy();
		}, 5_000);
		timer.unref?.();
		let done = false;
		const settle = (fn, value) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			fn(value);
		};
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				settle(reject, Object.assign(new Error('request body too large'), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8').trim();
			if (raw.length === 0) {
				settle(resolve, {});
				return;
			}
			try {
				settle(resolve, JSON.parse(raw));
			} catch (error) {
				settle(reject, error);
			}
		});
		req.on('error', (error) => { settle(reject, error); });
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
 * The reminder the model reads. The agent loop commits this as a `user/message`
 * event so it joins the next request's derived history; the browser never
 * renders it because its source kind is not `user` (see `SOURCE_KIND`). It is
 * therefore invisible in the conversation while still being part of what the
 * model is sent — the user's own input and the model's own output are never
 * modified.
 */
function noticeMessage(text, summary) {
	return {
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text }],
		source: {
			kind: SOURCE_KIND,
			form: 'notice',
			summary,
		},
		time: Date.now(),
	};
}

function lightText(hits) {
	const opening = hits > 1
		? `🍅 用户朝你扔了 ${hits} 个番茄，表示刚才的做法不对。`
		: '🍅 用户朝你扔了一个番茄，表示刚才的做法不对。';
	return `【扔番茄】${opening}

用户对刚才的做法不满意。当前任务已经结束（或即将结束），请按下面的要求做：

1. 先承认错误：明确指出你刚才哪一步做错了、为什么用户会不认可。
2. 深入思考「不该这么做的话，应该怎么做」：在思考过程里完整推演替代方案，包括应当先确认什么、应当改动哪些地方、以及如何避免同样的问题再次出现。
3. 本轮不要修改任何文件，也不要继续原任务，只做反思与方案。
4. 反思完成后，用 ask_user_question 工具把你的替代方案作为选项提问用户，简要说明每个选项的取舍；等用户回答后，再严格按用户的答复继续。

说明：这条提醒由用户点击番茄键触发，是系统注入到本次模型请求里的，不是用户手打的内容，也不会出现在对话记录里。`;
}

function heavyText(hits) {
	return `【扔番茄】🍅 用户怒气冲冲地朝你连扔了 ${hits} 个番茄，并且已经强行中断了刚才的任务。

用户认为刚才的做法明显不对。请立刻停下原有思路，按下面的要求做：

1. 先承认错误：明确指出你刚才哪一步做错了、为什么用户会不认可。
2. 深入思考「不该这么做的话，应该怎么做」：在思考过程里完整推演替代方案，包括应当先确认什么、应当改动哪些地方、以及如何避免类似问题再次出现。
3. 本轮不要修改任何文件，也不要继续原任务，只做反思与方案。
4. 反思完成后，用 ask_user_question 工具把你的替代方案作为选项提问用户，简要说明每个选项的取舍；等用户回答后，再严格按用户的答复继续。

说明：这条提醒由用户点击番茄键触发，是系统注入到本次模型请求里的，不是用户手打的内容，也不会出现在对话记录里。`;
}

/** Arm a reminder for the next request of one agent, merging an unclaimed one. */
function arm(agent, notice) {
	const pending = armed.get(agent);
	const alive = pending !== undefined && Date.now() - pending.armedAt <= ARM_TTL_MS;
	// Two tomatoes thrown before the first one landed must read as one stronger
	// reminder, not as "whatever was thrown last". A hard throw in the pair has
	// already interrupted the turn, so the merged notice keeps saying so.
	const hits = (alive ? pending.hits : 0) + notice.hits;
	const heavy = alive ? pending.heavy || notice.heavy : notice.heavy;
	const item = {
		text: heavy ? heavyText(hits) : lightText(hits),
		summary: heavy ? `🍅 连扔 ${hits} 个番茄，已中断当前任务` : `🍅 扔了 ${hits} 个番茄`,
		hits,
		heavy,
		armedAt: alive ? pending.armedAt : Date.now(),
	};
	armed.set(agent, item);
	return item;
}

/**
 * Take the reminder armed for the agent entering this step, if any.
 *
 * The dispatch injects `agent` into every agent event payload, so the reminder
 * is found by identity — it can never be handed to a different conversation.
 * The turn/step check keeps it to the step that opens a turn (a light throw must
 * wait for the running task to finish, and the restart opens exactly that turn)
 * and makes two tomatoes land as two reflections rather than one doubled one.
 * A payload that does not match leaves the reminder armed for a later step.
 *
 * @param {{ agent?: object, turn?: number, step?: number }} payload
 */
function claimArmed(payload) {
	const agent = payload?.agent;
	if (agent === undefined || agent === null) return null;
	const item = armed.get(agent);
	if (item === undefined) return null;
	if (Date.now() - item.armedAt > ARM_TTL_MS) {
		armed.delete(agent);
		return null;
	}
	const phase = agent.phase;
	if (phase?.kind !== 'running') return null;
	if (phase.turn !== payload.turn || phase.step !== payload.step - 1) return null;
	armed.delete(agent);
	return item;
}

/** Start (or keep) a turn so the armed reminder reaches a model request. */
function wake(agent) {
	if (typeof agent?.wakeDriver !== 'function') return;
	try {
		agent.wakeDriver();
	} catch {
		/* the driver refuses to restart while a turn owns the phase; the next
		 * natural turn picks the reminder up instead. */
	}
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
	const item = arm(agent, { hits, heavy });
	let stopped = false;
	if (heavy && agent.status === 'running') {
		// Same shape as the composer's own stop key, so queued user input survives.
		agent.cancel({ kind: 'user' }, { keepInbox: true });
		stopped = true;
	}
	// Wait for the current turn to release the phase, then start the turn that
	// carries the reminder. A light throw therefore lands right after the
	// running task finishes; a heavy one lands right after the interrupt.
	//
	// The wake is retried because the loop latches a wake it cannot honour yet
	// (an abort or a maintenance phase still owns the agent). The loop forwards
	// a latched wake on its own, but only while something is already running, so
	// a throw that lands during the idle transition would otherwise strand the
	// reminder until the next natural turn — possibly hours later.
	//
	// Giving up drops the reminder instead of leaving it armed: an armed notice
	// waiting out its TTL would be claimed by the user's own next turn and would
	// then tell the model to ignore what the user just asked for.
	const restart = (attempt = 0) => {
		if (!armed.has(agent)) return;
		wake(agent);
		if (agent.status === 'running') return;
		if (attempt >= 3) {
			armed.delete(agent);
			return;
		}
		const timer = setTimeout(() => restart(attempt + 1), 500 * (attempt + 1));
		timer.unref?.();
	};
	if (typeof agent.whenIdle === 'function') {
		try {
			Promise.resolve(agent.whenIdle()).then(() => restart(), () => restart());
		} catch {
			restart();
		}
	} else {
		restart();
	}
	return { ok: true, heavy: item.heavy, stopped };
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
		} catch (error) {
			const status = typeof error?.status === 'number' ? error.status : 400;
			sendJson(res, status, { ok: false, error: status === 413 ? 'body-too-large' : 'bad-json' });
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
	// Merge the armed reminder into the very next model request of that agent.
	// `prepend` keeps this ahead of the stock runtime-context provider so the
	// reminder reads last inside the assembled request.
	ctx.on('agent/pre-step', async (payload, next) => {
		const decision = await next();
		if (decision?.kind === 'reject' || payload?.signal?.aborted === true) return decision;
		// Only the first step of a turn carries the reminder: a light throw must
		// let the running task finish before the model reconsiders it, and the
		// restart below opens exactly that turn.
		if (payload?.step !== 1) return decision;
		const item = claimArmed(payload);
		if (item === null) return decision;
		const messages = Array.isArray(decision.messages) ? decision.messages : [];
		return {
			...decision,
			messages: [...messages, noticeMessage(item.text, item.summary)],
		};
	}, { prepend: true });

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

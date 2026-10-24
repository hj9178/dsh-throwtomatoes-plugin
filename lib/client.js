/**
 * dsh-throwtomatoes-plugin — browser half.
 *
 * Two surfaces:
 *  1. A tomato key that visually replaces the composer's primary send/stop key
 *     while a turn is running and the composer is empty. Pressing it never
 *     runs the original key's action (stop/send); it throws a tomato instead.
 *  2. A "扔番茄" page registered into `settings.section`.
 *
 * Everything is additive: the composer editor, its draft, and the model output
 * are never touched. The tomato key is a separate fixed-position element that
 * is painted on top of the primary button, so the original button keeps its
 * own state machine and its own click handler untouched.
 */

window.__ModuleLoader__.load({
	id: 'dsh-throwtomatoes-plugin',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;

		// #region package stylesheet
		const CSS = `
			.dtt-key {
				position: fixed;
				display: none;
				align-items: center;
				justify-content: center;
				margin: 0;
				padding: 0;
				border: 0;
				border-radius: 999px;
				background: linear-gradient(160deg, #ff6b5e 0%, #e23b2e 62%, #c2271b 100%);
				box-shadow: 0 2px 10px rgba(226, 59, 46, .46), inset 0 1px 0 rgba(255, 255, 255, .34);
				color: #fff;
				font-size: 17px;
				line-height: 1;
				cursor: pointer;
				z-index: 60;
				transform-origin: 50% 60%;
				transition: transform .12s ease, filter .12s ease;
				-webkit-tap-highlight-color: transparent;
			}
			.dtt-key[data-visible="true"] { display: flex; }
			.dtt-key:hover { filter: brightness(1.07); transform: scale(1.05); }
			.dtt-key:active { transform: scale(.9); }
			.dtt-key:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3, rgba(255,255,255,.6)), 0 2px 10px rgba(226, 59, 46, .46); }
.dtt-key[data-failed="true"] { filter: grayscale(1) brightness(.8); }
			.dtt-keyCore { pointer-events: none; display: block; filter: drop-shadow(0 1px 1px rgba(0,0,0,.28)); }
			.dtt-badge {
				position: absolute;
				top: -6px;
				right: -6px;
				min-width: 17px;
				height: 17px;
				padding: 0 4px;
				border-radius: 9px;
				background: #fff;
				color: #c2271b;
				font-size: 11px;
				font-weight: 700;
				line-height: 17px;
				text-align: center;
				box-shadow: 0 1px 4px rgba(0,0,0,.28);
				display: none;
			}
			.dtt-badge[data-visible="true"] { display: block; }

			.dtt-layer { position: fixed; inset: 0; pointer-events: none; z-index: 900; overflow: hidden; }
			.dtt-fly {
				position: fixed;
				left: 0; top: 0;
				font-size: 30px;
				line-height: 1;
				will-change: transform, opacity;
				pointer-events: none;
			}
			.dtt-particle {
				position: fixed;
				left: 0; top: 0;
				border-radius: 50%;
				pointer-events: none;
				will-change: transform, opacity;
			}
			.dtt-splat {
				position: fixed;
				pointer-events: none;
				font-weight: 800;
				font-size: 22px;
				color: #e23b2e;
				text-shadow: 0 2px 0 #fff, 0 0 14px rgba(226,59,46,.55);
				will-change: transform, opacity;
			}
			@keyframes dtt-shake {
				0%, 100% { transform: translate3d(0, 0, 0) }
				18% { transform: translate3d(-5px, 3px, 0) }
				36% { transform: translate3d(4px, -4px, 0) }
				54% { transform: translate3d(-4px, -2px, 0) }
				72% { transform: translate3d(3px, 3px, 0) }
				88% { transform: translate3d(-2px, 0, 0) }
			}
			.dtt-shake { animation: dtt-shake .34s cubic-bezier(.36,.07,.19,.97) both; }

			.dtt-page { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 24px; max-width: 720px; }
			.dtt-hero { display: flex; align-items: center; gap: 12px; padding: 16px; border-radius: 14px; background: linear-gradient(135deg, rgba(255,107,94,.14), rgba(226,59,46,.05)); border: 1px solid var(--dsw-alias-border-l1); }
			.dtt-heroIcon { font-size: 34px; line-height: 1; filter: drop-shadow(0 2px 4px rgba(226,59,46,.35)); }
			.dtt-heroCopy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
			.dtt-heroTitle { font-size: 16px; font-weight: 650; color: var(--dsw-alias-label-primary); }
			.dtt-heroSub { font-size: 13px; color: var(--dsw-alias-label-tertiary); }
			.dtt-count { margin-left: auto; display: flex; align-items: baseline; gap: 6px; padding: 6px 12px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
			.dtt-countNum { font-size: 22px; font-weight: 700; color: #e23b2e; font-variant-numeric: tabular-nums; }
			.dtt-countLabel { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
			.dtt-card { display: flex; flex-direction: column; border-radius: 12px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); overflow: hidden; }
			.dtt-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; }
			.dtt-row + .dtt-row { border-top: 1px solid var(--dsw-alias-border-l1); }
			.dtt-rowCopy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
			.dtt-rowTitle { font-size: 13px; font-weight: 550; color: var(--dsw-alias-label-primary); }
			.dtt-rowHint { font-size: 12px; color: var(--dsw-alias-label-tertiary); line-height: 18px; }
			.dtt-switch { position: relative; flex: none; width: 40px; height: 22px; border-radius: 11px; border: 0; padding: 0; cursor: pointer; background: var(--dsw-alias-border-l2, rgba(0,0,0,.18)); transition: background .16s ease; }
			.dtt-switch[aria-checked="true"] { background: #e23b2e; }
			.dtt-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .16s ease; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
			.dtt-switch[aria-checked="true"]::after { transform: translateX(18px); }
			.dtt-actions { display: flex; gap: 10px; flex-wrap: wrap; }
			.dtt-btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; }
			.dtt-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
			.dtt-btn[data-danger="true"] { color: #e23b2e; }
			.dtt-note { font-size: 12px; line-height: 19px; color: var(--dsw-alias-label-tertiary); }
			.dtt-note b { color: var(--dsw-alias-label-secondary); font-weight: 600; }
		`;

		function installStyles() {
			if (typeof document === 'undefined') return () => {};
			const existing = document.querySelector('style[data-plugin-css="dsh-throwtomatoes-plugin"]');
			if (existing !== null) return () => {};
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-throwtomatoes-plugin';
			tag.dataset.pluginCss = 'dsh-throwtomatoes-plugin';
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => { tag.remove(); };
		}
		// #endregion

		// #region persisted store
		const STORE_KEY = 'dsh-throwtomatoes:settings:v1';
		const COUNT_KEY = 'dsh-throwtomatoes:count:v1';
		const DEFAULT_SETTINGS = { effects: true, sound: true };

		const memoryStore = new Map();
		const subscribers = new Set();

		function storageGet(key) {
			try {
				const value = window.localStorage.getItem(key);
				return value === null ? memoryStore.get(key) ?? null : value;
			} catch {
				return memoryStore.get(key) ?? null;
			}
		}

		function storageSet(key, value) {
			memoryStore.set(key, value);
			try {
				window.localStorage.setItem(key, value);
			} catch {
				/* private mode / quota — the in-memory mirror keeps the session working */
			}
		}

		function readSettings() {
			try {
				const raw = storageGet(STORE_KEY);
				if (raw === null) return { ...DEFAULT_SETTINGS };
				const parsed = JSON.parse(raw);
				return {
					effects: typeof parsed.effects === 'boolean' ? parsed.effects : DEFAULT_SETTINGS.effects,
					sound: typeof parsed.sound === 'boolean' ? parsed.sound : DEFAULT_SETTINGS.sound,
				};
			} catch {
				return { ...DEFAULT_SETTINGS };
			}
		}

		function writeSettings(patch) {
			const next = { ...readSettings(), ...patch };
			storageSet(STORE_KEY, JSON.stringify(next));
			notify();
			return next;
		}

		function readCount() {
			const raw = storageGet(COUNT_KEY);
			const parsed = Number.parseInt(raw ?? '0', 10);
			return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
		}

		function bumpCount(delta) {
			const next = readCount() + delta;
			storageSet(COUNT_KEY, String(next));
			notify();
			return next;
		}

		function resetCount() {
			storageSet(COUNT_KEY, '0');
			notify();
		}

		function notify() {
			for (const listener of [...subscribers]) {
				try { listener(); } catch { /* one broken subscriber must not stop the rest */ }
			}
		}

		function subscribe(listener) {
			subscribers.add(listener);
			return () => { subscribers.delete(listener); };
		}
		// #endregion

		// #region sound
		let audioContext = null;

		function audio() {
			if (typeof window === 'undefined') return null;
			const Ctor = window.AudioContext ?? window.webkitAudioContext;
			if (Ctor === undefined) return null;
			if (audioContext === null) {
				try { audioContext = new Ctor(); } catch { return null; }
			}
			if (audioContext.state === 'suspended') {
				void audioContext.resume().catch(() => {});
			}
			return audioContext;
		}

		function noiseBurst(ac, when, duration, gainValue, filterFrom, filterTo) {
			const frames = Math.max(1, Math.floor(ac.sampleRate * duration));
			const buffer = ac.createBuffer(1, frames, ac.sampleRate);
			const data = buffer.getChannelData(0);
			for (let i = 0; i < frames; i += 1) {
				// White noise with a falling envelope — reads as "air + impact".
				data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
			}
			const source = ac.createBufferSource();
			source.buffer = buffer;
			const filter = ac.createBiquadFilter();
			filter.type = 'bandpass';
			filter.Q.value = 1.1;
			filter.frequency.setValueAtTime(filterFrom, when);
			filter.frequency.exponentialRampToValueAtTime(Math.max(60, filterTo), when + duration);
			const gain = ac.createGain();
			gain.gain.setValueAtTime(gainValue, when);
			gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
			source.connect(filter).connect(gain).connect(ac.destination);
			source.start(when);
			source.stop(when + duration + 0.02);
		}

		function tone(ac, when, duration, fromHz, toHz, gainValue, type) {
			const osc = ac.createOscillator();
			osc.type = type ?? 'sine';
			osc.frequency.setValueAtTime(fromHz, when);
			osc.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), when + duration);
			const gain = ac.createGain();
			gain.gain.setValueAtTime(0.0001, when);
			gain.gain.exponentialRampToValueAtTime(gainValue, when + 0.012);
			gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
			osc.connect(gain).connect(ac.destination);
			osc.start(when);
			osc.stop(when + duration + 0.02);
		}

		/** The throw itself: a short airy whoosh while the tomato is in flight. */
		function playThrow() {
			const ac = audio();
			if (ac === null) return;
			const now = ac.currentTime + 0.005;
			noiseBurst(ac, now, 0.17, 0.16, 2400, 620);
		}

		/** Impact: a low thump plus a juicy splat. */
		function playSplat() {
			const ac = audio();
			if (ac === null) return;
			const now = ac.currentTime + 0.005;
			tone(ac, now, 0.16, 190, 62, 0.32, 'sine');
			noiseBurst(ac, now, 0.13, 0.3, 1500, 260);
			noiseBurst(ac, now + 0.02, 0.1, 0.12, 3400, 900);
		}
		// #endregion

		// #region effects
		function fxLayer() {
			let layer = document.getElementById('dtt-layer');
			if (layer !== null) return layer;
			layer = document.createElement('div');
			layer.id = 'dtt-layer';
			layer.className = 'dtt-layer';
			layer.setAttribute('aria-hidden', 'true');
			document.body.appendChild(layer);
			return layer;
		}

		function animateOrRemove(node, keyframes, options) {
			const animation = node.animate(keyframes, options);
			animation.addEventListener('finish', () => { node.remove(); }, { once: true });
			animation.addEventListener('cancel', () => { node.remove(); }, { once: true });
			return animation;
		}

		function splash(x, y) {
			const layer = fxLayer();
			for (let i = 0; i < 12; i += 1) {
				const particle = document.createElement('div');
				particle.className = 'dtt-particle';
				const size = 4 + Math.random() * 7;
				particle.style.width = `${size}px`;
				particle.style.height = `${size}px`;
				particle.style.background = i % 4 === 0 ? '#8f1a12' : i % 3 === 0 ? '#ff7a6d' : '#e23b2e';
				particle.style.opacity = '0.92';
				particle.style.transform = `translate3d(${x}px, ${y}px, 0)`;
				layer.appendChild(particle);
				const angle = Math.random() * Math.PI * 2;
				const distance = 26 + Math.random() * 96;
				const dx = Math.cos(angle) * distance;
				const dy = Math.sin(angle) * distance + 34 + Math.random() * 46;
				animateOrRemove(particle, [
					{ transform: `translate3d(${x}px, ${y}px, 0) scale(1)`, opacity: 0.95 },
					{ transform: `translate3d(${x + dx}px, ${y + dy}px, 0) scale(${0.4 + Math.random() * 0.8})`, opacity: 0 },
				], { duration: 460 + Math.random() * 320, easing: 'cubic-bezier(.2,.6,.3,1)', fill: 'forwards' });
			}

			const stamp = document.createElement('div');
			stamp.className = 'dtt-splat';
			stamp.textContent = '啪！';
			stamp.style.transform = `translate3d(${x - 18}px, ${y - 26}px, 0)`;
			layer.appendChild(stamp);
			animateOrRemove(stamp, [
				{ transform: `translate3d(${x - 18}px, ${y - 26}px, 0) scale(.4) rotate(-8deg)`, opacity: 0 },
				{ transform: `translate3d(${x - 18}px, ${y - 40}px, 0) scale(1.16) rotate(-8deg)`, opacity: 1, offset: 0.28 },
				{ transform: `translate3d(${x - 18}px, ${y - 52}px, 0) scale(1) rotate(-8deg)`, opacity: 0 },
			], { duration: 720, easing: 'ease-out', fill: 'forwards' });

			const root = document.querySelector('#root') ?? document.body;
			root.classList.remove('dtt-shake');
			// Force a reflow so the same animation can replay on rapid repeats.
			void root.offsetWidth;
			root.classList.add('dtt-shake');
			window.setTimeout(() => { root.classList.remove('dtt-shake'); }, 420);
		}

		/**
		 * Throw one tomato from `from` toward a point in the conversation area.
		 * @param {{ x: number, y: number }} from - viewport coordinates of the tomato key.
		 * @param {{ effects: boolean, sound: boolean }} settings - current preferences.
		 */
		function throwTomato(from, settings) {
			if (settings.sound) playThrow();
			if (!settings.effects) {
				if (settings.sound) window.setTimeout(playSplat, 230);
				return;
			}
			const layer = fxLayer();
			const target = {
				x: window.innerWidth * (0.42 + Math.random() * 0.16),
				y: window.innerHeight * (0.3 + Math.random() * 0.14),
			};
			const tomato = document.createElement('div');
			tomato.className = 'dtt-fly';
			tomato.textContent = '🍅';
			tomato.style.transform = `translate3d(${from.x - 15}px, ${from.y - 15}px, 0)`;
			layer.appendChild(tomato);

			const dx = target.x - from.x;
			const dy = target.y - from.y;
			const midX = from.x + dx * 0.55;
			const midY = from.y + dy * 0.32 - 110;

			const animation = tomato.animate([
				{ transform: `translate3d(${from.x - 15}px, ${from.y - 15}px, 0) rotate(0deg) scale(.5)`, opacity: 0.2, offset: 0 },
				{ transform: `translate3d(${midX - 15}px, ${midY - 15}px, 0) rotate(220deg) scale(1.2)`, opacity: 1, offset: 0.52 },
				{ transform: `translate3d(${target.x - 15}px, ${target.y - 15}px, 0) rotate(520deg) scale(1.05)`, opacity: 1, offset: 1 },
			], { duration: 360, easing: 'cubic-bezier(.32,.02,.66,1)', fill: 'forwards' });

			animation.addEventListener('finish', () => {
				tomato.remove();
				splash(target.x, target.y);
				if (settings.sound) playSplat();
			}, { once: true });
		}
		// #endregion

		// #region composer seat + tomato key
		/** card element -> { sessionId } for every mounted composer bar. */
		const seats = new Map();
		const STREAK_WINDOW = 1000;
		const HEAVY_THRESHOLD = 3;

		function composerCardOf(node) {
			if (!(node instanceof Element)) return null;
			return node.closest('[data-composer-card]');
		}

		function isVisible(card) {
			if (!card.isConnected) return false;
			const rect = card.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return false;
			return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
		}

		/** The composer's primary key is the last <button> React renders inside the card. */
		function primaryButtonOf(card) {
			const buttons = card.querySelectorAll('button');
			if (buttons.length === 0) return null;
			const candidate = buttons[buttons.length - 1];
			const rect = candidate.getBoundingClientRect();
			const cardRect = card.getBoundingClientRect();
			// Guard against future layout changes: the primary key sits in the
			// bottom-right corner of the composer card.
			if (rect.width < 16 || rect.height < 16) return null;
			if (rect.right < cardRect.right - cardRect.width * 0.55) return null;
			if (rect.top < cardRect.top + cardRect.height * 0.4) return null;
			return candidate;
		}

		/** True when the primary key currently renders the stop square. */
		function isStopState(button) {
			return button.querySelector('svg rect') !== null;
		}

		/** True when the composer draft holds no text (attachments are irrelevant here). */
		function isDraftEmpty(card) {
			const editor = card.querySelector('[contenteditable]:not([contenteditable="false"])');
			if (editor === null) return false;
			return (editor.textContent ?? '').trim() === '';
		}

		/** Session id of the conversation a composer card belongs to, read from the DOM. */
		function sessionIdOfCard(card) {
			const holder = card.closest('[data-conversation-session]');
			const value = holder?.getAttribute('data-conversation-session');
			if (typeof value === 'string' && value.length > 0) return value;
			const any = document.querySelector('[data-conversation-session]');
			const fallback = any?.getAttribute('data-conversation-session');
			return typeof fallback === 'string' && fallback.length > 0 ? fallback : undefined;
		}

		/** Running flag straight from the session snapshot, or null when unknown. */
		function runningOf(ctx, sessionId) {
			if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
			const snapshot = sessionFor(ctx, sessionId)?.getSnapshot?.();
			return typeof snapshot?.running === 'boolean' ? snapshot.running : null;
		}

		/** Bottom-right anchor used when the primary key cannot be located. */
		function cornerRect(card) {
			const cardRect = card.getBoundingClientRect();
			const size = 34;
			return {
				left: cardRect.right - size - 8,
				top: cardRect.bottom - size - 8,
				width: size,
				height: size,
			};
		}

		function activeSeat() {
			let fallback = null;
			for (const [card, info] of seats) {
				if (!isVisible(card)) continue;
				const sessionId = typeof info.sessionId === 'string' && info.sessionId.length > 0
					? info.sessionId
					: sessionIdOfCard(card);
				const primary = primaryButtonOf(card);
				const candidate = { card, primary, sessionId };
				if (primary !== null) return candidate;
				if (fallback === null) fallback = candidate;
			}
			return fallback;
		}

		function createTomatoKey() {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'dtt-key';
			button.dataset.visible = 'false';
			button.dataset.failed = 'false';
			button.setAttribute('aria-label', '扔番茄');
			button.setAttribute('title', '扔番茄：点一下轻扔，短时连按三次重扔');
			const core = document.createElement('span');
			core.className = 'dtt-keyCore';
			core.textContent = '🍅';
			const badge = document.createElement('span');
			badge.className = 'dtt-badge';
			badge.dataset.visible = 'false';
			button.append(core, badge);
			return { button, badge };
		}
		// #endregion

		// #region delivery
		/** Host half route; keep in sync with `lib/index.js`. */
		const HOST_ROUTE = '/_dsh/throwtomatoes';

		/**
		 * Ask the host half to merge the reminder into the model request and, for
		 * a heavy throw, to interrupt the running turn. Resolves with the host's
		 * JSON answer; throws when the bridge is missing or refused the request.
		 */
		async function postToHost(payload) {
			const response = await fetch(`${HOST_ROUTE}/throw`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			});
			const raw = await response.text();
			let parsed = null;
			try {
				parsed = raw.length > 0 ? JSON.parse(raw) : null;
			} catch { /* non-JSON body: fall through to the status check */ }
			if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 160)}`);
			return parsed;
		}

		/**
		 * Resolve the live Session object for a session id, if the conversation
		 * surface has it retained. Used read-only, to ask whether the turn is
		 * running; delivery always goes through the host bridge.
		 */
		function sessionFor(ctx, sessionId) {
			try {
				const sessions = ctx.get('sessions');
				const binding = sessions?.binding?.(sessionId);
				return binding?.session ?? undefined;
			} catch {
				return undefined;
			}
		}

		let delivering = false;

		/**
		 * Hand one throw to the host half, which merges the reminder into the
		 * model request itself (no queued user message, nothing rendered in the
		 * conversation). Resolves to `true` when the host accepted the throw.
		 */
		async function deliver(ctx, seat, hits) {
			if (delivering) return true;
			delivering = true;
			try {
				bumpCount(hits);
				const declared = seat.sessionId;
				const sessionId = typeof declared === 'string' && declared.length > 0
					? declared
					: sessionIdOfCard(seat.card);
				if (typeof sessionId !== 'string' || sessionId.length === 0) {
					console.warn('[throwtomatoes] cannot resolve the conversation session for this composer');
					return false;
				}
				const heavy = hits >= HEAVY_THRESHOLD;
				try {
					const result = await postToHost({ sessionId, hits, heavy });
					if (result !== null && result.ok === true) return true;
					console.warn('[throwtomatoes] the host half refused the tomato notice', result);
				} catch (error) {
					// No visible fallback on purpose: showing the reminder as a user
					// message is exactly what this plugin must never do, so a broken
					// bridge fails quietly (the key flashes instead).
					console.warn('[throwtomatoes] the host bridge is unavailable, so nothing was delivered', error);
				}
				return false;
			} finally {
				delivering = false;
			}
		}
		// #endregion

		// #region slots
		function apply(ctx) {
			const removeStyles = installStyles();
			const disposers = [removeStyles];

			const slots = ctx.get('slots');
			const { button: tomatoKey, badge } = createTomatoKey();
			document.body.appendChild(tomatoKey);

			let boundSeat = null;
			let boundPrimaryRect = null;
			let streakTimer = 0;
			let streakCount = 0;
			let flashing = false;

			const setBadge = (value) => {
				if (value > 0) {
					badge.textContent = String(value);
					badge.dataset.visible = 'true';
				} else {
					badge.dataset.visible = 'false';
				}
			};

			let lastPaint = 'hidden';
			let syncQueued = false;
			let pageVisible = (typeof document.visibilityState === 'string' ? document.visibilityState : 'visible') !== 'hidden';

			const hideKey = () => {
				tomatoKey.dataset.visible = 'false';
				boundSeat = null;
				boundPrimaryRect = null;
				lastPaint = 'hidden';
				setBadge(0);
			};

			/* Event-driven sync: the composer tells us when it changed, so the
			 * key never needs a per-frame poll (the 0.1.x build polled every
			 * 180 ms and forced several layouts per tick). */
			const syncKey = () => {
				if (flashing) return;
				const seat = activeSeat();
				if (seat === null) {
					hideKey();
					return;
				}
				const running = runningOf(ctx, seat.sessionId);
				const stop = running === null
					? (seat.primary !== null && isStopState(seat.primary))
					: running;
				const empty = isDraftEmpty(seat.card);
				if (!stop || !empty) {
					hideKey();
					return;
				}
				const rect = seat.primary === null
					? cornerRect(seat.card)
					: seat.primary.getBoundingClientRect();
				if (rect.width < 8 || rect.height < 8) {
					hideKey();
					return;
				}
				boundSeat = seat;
				boundPrimaryRect = rect;
				const paint = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
				if (paint === lastPaint && tomatoKey.dataset.visible === 'true') return;
				lastPaint = paint;
				tomatoKey.style.left = `${rect.left}px`;
				tomatoKey.style.top = `${rect.top}px`;
				tomatoKey.style.width = `${rect.width}px`;
				tomatoKey.style.height = `${rect.height}px`;
				tomatoKey.style.borderRadius = `${Math.min(rect.width, rect.height) / 2}px`;
				tomatoKey.dataset.visible = 'true';
			};

			const scheduleSync = () => {
				if (syncQueued || !pageVisible) return;
				syncQueued = true;
				const raf = typeof window.requestAnimationFrame === 'function'
					? window.requestAnimationFrame.bind(window)
					: (fn) => window.setTimeout(fn, 16);
				raf(() => {
					syncQueued = false;
					if (!pageVisible) return;
					syncKey();
				});
			};

			/* Per-card mutation observers: React swaps the primary key's icon and
			 * flips its aria-label in place, which is a direct signal. Draft text
			 * arrives through the document-level `input` listener below. */
			const seatObservers = new Map();
			const MutationObserverCtor = window.MutationObserver ?? globalThis.MutationObserver;
			const observeSeat = (card) => {
				if (typeof MutationObserverCtor !== 'function' || seatObservers.has(card)) return;
				const observer = new MutationObserverCtor(() => { scheduleSync(); });
				observer.observe(card, {
					subtree: true,
					childList: true,
					attributes: true,
					attributeFilter: ['aria-label', 'disabled', 'class', 'data-visible', 'contenteditable'],
				});
				seatObservers.set(card, observer);
			};
			const unobserveSeat = (card) => {
				seatObservers.get(card)?.disconnect();
				seatObservers.delete(card);
			};

			let failTimer = 0;
			const flashFailure = () => {
				tomatoKey.dataset.failed = 'true';
				window.clearTimeout(failTimer);
				failTimer = window.setTimeout(() => { tomatoKey.dataset.failed = 'false'; }, 700);
			};

			const flushStreak = () => {
				window.clearTimeout(streakTimer);
				const hits = streakCount;
				streakCount = 0;
				setBadge(0);
				const seat = boundSeat;
				if (seat === null || hits === 0) return;
				deliver(ctx, seat, hits).then((ok) => {
					if (!ok) flashFailure();
				}, () => { flashFailure(); }).finally(() => { scheduleSync(); });
			};

			const onTomatoClick = (event) => {
				event.preventDefault();
				event.stopPropagation();
				const seat = boundSeat;
				if (seat === null) return;
				const rect = boundPrimaryRect ?? tomatoKey.getBoundingClientRect();
				const settings = readSettings();
				throwTomato({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, settings);
				streakCount += 1;
				setBadge(streakCount);
				window.clearTimeout(streakTimer);
				if (streakCount >= HEAVY_THRESHOLD) {
					flushStreak();
					return;
				}
				streakTimer = window.setTimeout(flushStreak, STREAK_WINDOW);
			};

			tomatoKey.addEventListener('pointerdown', (event) => {
				// Keep focus in the composer and never let the press reach the
				// original key underneath.
				event.preventDefault();
				event.stopPropagation();
			});
			tomatoKey.addEventListener('click', onTomatoClick);

			const onComposerInput = () => { scheduleSync(); };
			const onViewportChange = () => { scheduleSync(); };
			const onVisibilityChange = () => {
				pageVisible = (typeof document.visibilityState === 'string' ? document.visibilityState : 'visible') !== 'hidden';
				if (pageVisible) scheduleSync();
				else hideKey();
			};

			document.addEventListener('input', onComposerInput, true);
			document.addEventListener('keyup', onComposerInput, true);
			document.addEventListener('visibilitychange', onVisibilityChange);
			window.addEventListener('resize', onViewportChange, { passive: true });
			window.addEventListener('scroll', onViewportChange, { passive: true, capture: true });

			// Safety net only: two cheap checks per second used to cost a forced
			// layout each; this keeps the composer responsive to render paths we
			// cannot observe while staying idle the rest of the time.
			const ticker = window.setInterval(() => { scheduleSync(); }, 1500);
			scheduleSync();

			disposers.push(() => {
				window.clearInterval(ticker);
				window.clearTimeout(streakTimer);
				document.removeEventListener('input', onComposerInput, true);
				document.removeEventListener('keyup', onComposerInput, true);
				document.removeEventListener('visibilitychange', onVisibilityChange);
				window.removeEventListener('resize', onViewportChange);
				window.removeEventListener('scroll', onViewportChange, true);
				for (const observer of seatObservers.values()) observer.disconnect();
				seatObservers.clear();
				tomatoKey.remove();
			});

			if (slots !== undefined) {
				// Invisible seat: it only reports which session owns each composer
				// card, so the tomato key knows where to deliver the notice.
				slots.inject('conversation.input.overlay', () => slots.register({
					name: 'conversation.input.overlay',
					id: 'throwtomatoes-seat',
					order: 100,
					children: {},
				}, (props) => {
					const anchorRef = React.useRef(null);
					const declared = props?.sessionId;
					React.useEffect(() => {
						const node = anchorRef.current;
						const card = composerCardOf(node);
						if (card === null) return;
						const resolved = typeof declared === 'string' && declared.length > 0
							? declared
							: sessionIdOfCard(card);
						seats.set(card, { sessionId: resolved });
						observeSeat(card);
						scheduleSync();
						return () => {
							seats.delete(card);
							unobserveSeat(card);
							scheduleSync();
						};
					}, [declared]);
					return h('span', { ref: anchorRef, hidden: true, 'aria-hidden': true });
				}));

				slots.inject('settings.section', () => slots.register({
					name: 'settings.section',
					id: 'throwtomatoes',
					order: 24,
					label: () => '扔番茄',
					children: {},
				}, SettingsPage));
			}

			disposers.push(() => {
				seats.clear();
				document.getElementById('dtt-layer')?.remove();
			});

			const dispose = () => {
				for (const disposer of disposers.splice(0).reverse()) {
					try { disposer(); } catch { /* ignore teardown noise */ }
				}
			};
			if (typeof ctx.effect === 'function') {
				ctx.effect(() => dispose, 'dsh-throwtomatoes-plugin: surfaces');
			}
			return dispose;
		}
		// #endregion

		// #region settings page
		function Toggle(props) {
			return h('button', {
				type: 'button',
				className: 'dtt-switch',
				role: 'switch',
				'aria-checked': props.checked ? 'true' : 'false',
				'aria-label': props.label,
				onClick: () => { props.onChange(!props.checked); },
			});
		}

		function Row(props) {
			return h('div', { className: 'dtt-row' },
				h('div', { className: 'dtt-rowCopy' },
					h('div', { className: 'dtt-rowTitle' }, props.title),
					props.hint === undefined ? null : h('div', { className: 'dtt-rowHint' }, props.hint)),
				props.children);
		}

		function SettingsPage() {
			const [settings, setSettings] = React.useState(readSettings);
			const [count, setCount] = React.useState(readCount);

			React.useEffect(() => subscribe(() => {
				setSettings(readSettings());
				setCount(readCount());
			}), []);

			const preview = () => {
				const current = readSettings();
				const rect = tomatoKeyRectOrFallback();
				throwTomato({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, current);
			};

			return h('div', { className: 'dtt-page' },
				h('div', { className: 'dtt-hero' },
					h('div', { className: 'dtt-heroIcon' }, '🍅'),
					h('div', { className: 'dtt-heroCopy' },
						h('div', { className: 'dtt-heroTitle' }, '扔番茄'),
						h('div', { className: 'dtt-heroSub' }, '模型跑任务时，发送键会变成番茄键。')),
					h('div', { className: 'dtt-count' },
						h('span', { className: 'dtt-countNum' }, String(count)),
						h('span', { className: 'dtt-countLabel' }, '个番茄'))),

				h('div', { className: 'dtt-card' },
					h(Row, {
						title: '丢番茄特效',
						hint: '番茄从输入框飞出去砸中对话区，带溅射和屏幕颤动。',
					}, h(Toggle, {
						label: '丢番茄特效',
						checked: settings.effects,
						onChange: (value) => { writeSettings({ effects: value }); },
					})),
					h(Row, {
						title: '音效',
						hint: '投掷的破空声与命中的「啪」声。',
					}, h(Toggle, {
						label: '音效',
						checked: settings.sound,
						onChange: (value) => { writeSettings({ sound: value }); },
					}))),

				h('div', { className: 'dtt-actions' },
					h('button', { type: 'button', className: 'dtt-btn', onClick: preview }, '🍅 预览特效'),
					h('button', {
						type: 'button',
						className: 'dtt-btn',
						'data-danger': 'true',
						onClick: () => { resetCount(); },
					}, '重置计数')),

				h('div', { className: 'dtt-note' },
					h('b', null, '怎么用：'),
					'模型正在干活且输入框是空的时候，发送键会变成番茄键。',
					h('b', null, '点 1–2 下'),
					' = 轻扔：等当前任务结束后再提醒模型反思；',
					h('b', null, '1 秒内连点 3 下及以上'),
					' = 猛扔：先停掉当前任务，再提醒模型反思。两种情况都会让模型用提问工具给出替代方案。',
					h('br'),
					'插件不会改动你输入的文字，也不会改动模型的输出。计数保存在本机浏览器里。'));
		}

		function tomatoKeyRectOrFallback() {
			const key = document.querySelector('.dtt-key');
			if (key !== null) {
				const rect = key.getBoundingClientRect();
				if (rect.width > 0 && rect.height > 0) return rect;
			}
			return { left: window.innerWidth - 120, top: window.innerHeight - 80, width: 32, height: 32 };
		}
		// #endregion

		exports.apply = apply;
		// Only `slots` is a hard requirement: without it nothing can mount. The
		// session controller is resolved lazily in `ctx.get('sessions')` so the
		// plugin still loads (and the settings page still works) on hosts that
		// do not expose that client service.
		exports.inject = ['slots'];
		return module.exports;
	}
});

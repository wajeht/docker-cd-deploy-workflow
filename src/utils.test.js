import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectHost, collectHosts } from './utils.js';

describe('collectHosts', () => {
	it('collects all unique hosts from labels', () => {
		const services = {
			app: {
				labels: [
					'traefik.http.routers.app.rule=Host(`closepowerlifting.com`) || Host(`www.closepowerlifting.com`)',
					'traefik.http.routers.app-redirect.rule=Host(`close-powerlifting.jaw.dev`)',
				],
			},
		};
		assert.deepStrictEqual(collectHosts(services), ['closepowerlifting.com', 'www.closepowerlifting.com', 'close-powerlifting.jaw.dev']);
	});

	it('deduplicates hosts', () => {
		const services = {
			app: {
				labels: [
					'traefik.http.routers.app.rule=Host(`app.jaw.dev`)',
					'traefik.http.routers.app2.rule=Host(`app.jaw.dev`)',
				],
			},
		};
		assert.deepStrictEqual(collectHosts(services), ['app.jaw.dev']);
	});

	it('returns empty array when no hosts', () => {
		const services = { app: { labels: ['traefik.enable=true'] } };
		assert.deepStrictEqual(collectHosts(services), []);
	});
});

describe('detectHost', () => {
	it('picks jaw.dev subdomain over bare/www domain (closepowerlifting bug)', () => {
		const services = {
			app: {
				labels: [
					'traefik.http.routers.app.rule=Host(`closepowerlifting.com`) || Host(`www.closepowerlifting.com`)',
					'traefik.http.routers.app-redirect.rule=Host(`close-powerlifting.jaw.dev`)',
				],
			},
		};
		assert.strictEqual(detectHost(services), 'close-powerlifting.jaw.dev');
	});

	it('produces correct temp URL for closepowerlifting', () => {
		const services = {
			app: {
				labels: [
					'traefik.http.routers.app.rule=Host(`closepowerlifting.com`) || Host(`www.closepowerlifting.com`)',
					'traefik.http.routers.app-redirect.rule=Host(`close-powerlifting.jaw.dev`)',
				],
			},
		};
		const host = detectHost(services);
		const domain = host.split('.').slice(1).join('.');
		const hostname = `pr-148-close-powerlifting.${domain}`;
		assert.strictEqual(hostname, 'pr-148-close-powerlifting.jaw.dev');
	});

	it('works with simple subdomain host (bang.jaw.dev)', () => {
		const services = {
			app: {
				labels: ['traefik.http.routers.bang.rule=Host(`bang.jaw.dev`)'],
			},
		};
		assert.strictEqual(detectHost(services), 'bang.jaw.dev');
	});

	it('falls back to bare domain if no subdomain exists', () => {
		const services = {
			app: {
				labels: ['traefik.http.routers.app.rule=Host(`example.com`)'],
			},
		};
		assert.strictEqual(detectHost(services), 'example.com');
	});

	it('returns null when no Host() labels', () => {
		const services = {
			app: { labels: ['traefik.enable=true'] },
		};
		assert.strictEqual(detectHost(services), null);
	});

	it('returns null when no labels at all', () => {
		const services = {
			app: { image: 'nginx' },
		};
		assert.strictEqual(detectHost(services), null);
	});

	it('handles multiple services', () => {
		const services = {
			app: {
				labels: ['traefik.http.routers.app.rule=Host(`myapp.com`)'],
			},
			redirect: {
				labels: ['traefik.http.routers.redirect.rule=Host(`app.jaw.dev`)'],
			},
		};
		assert.strictEqual(detectHost(services), 'app.jaw.dev');
	});
});

describe('label rewriting (integration)', () => {
	it('replaces all hosts and strips redirect labels for closepowerlifting', () => {
		const labels = [
			'traefik.enable=true',
			'traefik.http.routers.close-powerlifting.rule=Host(`closepowerlifting.com`) || Host(`www.closepowerlifting.com`)',
			'traefik.http.routers.close-powerlifting.entrypoints=websecure',
			'traefik.http.routers.close-powerlifting.middlewares=rate-limit-global@file',
			'traefik.http.services.close-powerlifting.loadbalancer.server.port=80',
			'traefik.http.routers.close-powerlifting-redirect.rule=Host(`close-powerlifting.jaw.dev`)',
			'traefik.http.routers.close-powerlifting-redirect.entrypoints=websecure',
			'traefik.http.routers.close-powerlifting-redirect.middlewares=close-powerlifting-redirect',
			'traefik.http.routers.close-powerlifting-redirect.service=noop@internal',
			'traefik.http.middlewares.close-powerlifting-redirect.redirectregex.regex=^https?://close-powerlifting\\.jaw\\.dev(.*)$',
			'traefik.http.middlewares.close-powerlifting-redirect.redirectregex.replacement=https://closepowerlifting.com$1',
			'traefik.http.middlewares.close-powerlifting-redirect.redirectregex.permanent=true',
		];

		const services = { app: { labels } };
		const allHosts = collectHosts(services);
		const appName = 'close-powerlifting';
		const tempName = 'close-powerlifting-pr-148';
		const hostname = 'pr-148-close-powerlifting.jaw.dev';

		const rewritten = labels
			.filter((label) => !label.includes('redirect'))
			.map((label) =>
				label
					.replaceAll(`traefik.http.routers.${appName}`, `traefik.http.routers.${tempName}`)
					.replaceAll(`traefik.http.services.${appName}`, `traefik.http.services.${tempName}`)
					.replace(/Host\(`[^`]+`\)/g, `Host(\`${hostname}\`)`),
			);

		assert.deepStrictEqual(rewritten, [
			'traefik.enable=true',
			`traefik.http.routers.close-powerlifting-pr-148.rule=Host(\`pr-148-close-powerlifting.jaw.dev\`) || Host(\`pr-148-close-powerlifting.jaw.dev\`)`,
			'traefik.http.routers.close-powerlifting-pr-148.entrypoints=websecure',
			'traefik.http.routers.close-powerlifting-pr-148.middlewares=rate-limit-global@file',
			'traefik.http.services.close-powerlifting-pr-148.loadbalancer.server.port=80',
		]);
	});
});

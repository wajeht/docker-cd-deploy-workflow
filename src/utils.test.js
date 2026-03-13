import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectHost } from './utils.js';

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

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
	detectHost,
	collectHosts,
	dependentServices,
	dependsOnServices,
	isObject,
	parseArgs,
	tempStackPath,
} from './utils.js';

describe('parseArgs', () => {
	it('parses flags and values', () => {
		assert.deepStrictEqual(parseArgs(['--app-path', 'apps/demo', '--all']), {
			'app-path': 'apps/demo',
			all: true,
		});
	});

	it('throws when required args are missing', () => {
		assert.throws(() => parseArgs([], { required: ['app-path'] }), /Missing required arg: --app-path/);
	});
});

describe('isObject', () => {
	it('returns true only for plain object-like values', () => {
		assert.strictEqual(isObject({}), true);
		assert.strictEqual(isObject([]), false);
		assert.strictEqual(isObject(null), false);
		assert.strictEqual(isObject('value'), false);
	});
});

describe('tempStackPath', () => {
	it('builds the temp stack path from app path and PR number', () => {
		assert.strictEqual(tempStackPath('apps/demo', '42'), 'apps/demo-pr-42');
	});
});

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

describe('dependsOnServices', () => {
	it('reads list syntax', () => {
		assert.deepStrictEqual(dependsOnServices({ depends_on: ['db', 'redis'] }), ['db', 'redis']);
	});

	it('reads condition map syntax', () => {
		assert.deepStrictEqual(dependsOnServices({ depends_on: { db: { condition: 'service_healthy' } } }), ['db']);
	});

	it('ignores missing depends_on', () => {
		assert.deepStrictEqual(dependsOnServices({ image: 'nginx' }), []);
	});
});

describe('dependentServices', () => {
	it('keeps the app service when there are no dependencies', () => {
		const selected = dependentServices({ web: { image: 'nginx' }, worker: { image: 'nginx' } }, 'web');

		assert.deepStrictEqual([...selected].sort(), ['web']);
	});

	it('follows recursive dependencies and skips siblings', () => {
		const selected = dependentServices(
			{
				web: { depends_on: { api: { condition: 'service_started' } } },
				api: { depends_on: ['db'] },
				db: { image: 'postgres' },
				worker: { depends_on: ['db'] },
			},
			'web',
		);

		assert.deepStrictEqual([...selected].sort(), ['api', 'db', 'web']);
	});

	it('returns an empty set when the app service is missing', () => {
		assert.deepStrictEqual([...dependentServices({ db: { image: 'postgres' } }, 'web')], []);
	});
});

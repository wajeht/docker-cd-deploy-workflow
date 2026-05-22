import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
	collectHosts,
	dependentServices,
	dependsOnServices,
	detectHost,
	rewriteComposeForTempDeploy,
} from './temp-compose.js';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'temp-compose.js');

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

describe('temp-compose', () => {
	it('uses service-name as the dependency root and router prefix', () => {
		const result = rewriteComposeForTempDeploy(
			{
				services: {
					api: {
						image: 'ghcr.io/wajeht/example:old',
						depends_on: ['db'],
						labels: [
							'traefik.http.routers.api.rule=Host(`example.jaw.dev`)',
							'traefik.http.services.api.loadbalancer.server.port=3000',
						],
					},
					db: {
						image: 'postgres:17-alpine',
					},
					worker: {
						image: 'ghcr.io/wajeht/example-worker:old',
					},
				},
			},
			{
				appName: 'example',
				serviceName: 'api',
				tag: 'abc1234',
				prNumber: '42',
				repoOwner: 'wajeht',
			},
		);

		assert.deepStrictEqual(Object.keys(result.doc.services).sort(), ['api', 'db']);
		assert.strictEqual(result.doc.services.api.image, 'ghcr.io/wajeht/example:abc1234');
		assert.deepStrictEqual(result.doc.services.api.labels, [
			'traefik.http.routers.api-pr-42.rule=Host(`pr-42-example.jaw.dev`)',
			'traefik.http.services.api-pr-42.loadbalancer.server.port=3000',
		]);
		assert.strictEqual(result.url, 'https://pr-42-example.jaw.dev');
	});

	it('fails when service-name is not present', () => {
		assert.throws(
			() =>
				rewriteComposeForTempDeploy(
					{ services: { web: { image: 'nginx' } } },
					{
						appName: 'example',
						serviceName: 'api',
						tag: 'abc1234',
						prNumber: '42',
						repoOwner: 'wajeht',
					},
				),
			/Could not find app service "api"/,
		);
	});

	it('keeps the app service and its dependencies only', () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-cd-deploy-workflow-'));
		const appPath = path.join(tempDir, 'apps', 'demo');
		const tempPath = `${appPath}-pr-42`;

		try {
			fs.mkdirSync(appPath, { recursive: true });
			fs.writeFileSync(
				path.join(appPath, 'docker-compose.yml'),
				yaml.dump({
					services: {
						demo: {
							image: 'ghcr.io/wajeht/demo:old',
							depends_on: {
								'demo-db': { condition: 'service_healthy' },
							},
							networks: ['traefik', 'internal'],
							labels: [
								'traefik.enable=true',
								'traefik.http.routers.demo.rule=Host(`demo.jaw.dev`)',
								'traefik.http.services.demo.loadbalancer.server.port=3000',
							],
						},
						'demo-db': {
							container_name: 'demo-db',
							image: 'postgres:17-alpine',
							volumes: ['/home/jaw/data/demo/db:/var/lib/postgresql/data'],
							networks: ['internal'],
						},
						worker: {
							image: 'ghcr.io/wajeht/demo-worker:old',
							volumes: ['/home/jaw/data/demo/worker:/data'],
							networks: ['worker-only'],
						},
					},
					networks: {
						traefik: { external: true },
						internal: null,
						'worker-only': null,
					},
					volumes: {
						'worker-cache': null,
					},
				}),
			);

			execFileSync('node', [
				scriptPath,
				'--app-path',
				appPath,
				'--service-name',
				'demo',
				'--tag',
				'abc1234',
				'--pr-number',
				'42',
				'--repo-owner',
				'wajeht',
			]);

			const rewritten = yaml.load(fs.readFileSync(path.join(tempPath, 'docker-compose.yml'), 'utf8'));

			assert.deepStrictEqual(Object.keys(rewritten.services).sort(), ['demo', 'demo-db']);
			assert.strictEqual(rewritten.services.demo.image, 'ghcr.io/wajeht/demo:abc1234');
			assert.strictEqual(rewritten.services['demo-db'].container_name, undefined);
			assert.deepStrictEqual(Object.keys(rewritten.networks).sort(), ['internal', 'traefik']);
			assert.deepStrictEqual(Object.keys(rewritten.volumes), ['db']);
			assert.strictEqual(rewritten.services.demo.labels[1], 'traefik.http.routers.demo-pr-42.rule=Host(`pr-42-demo.jaw.dev`)');
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
	ADMIN_ALLOW,
	USERS_ALLOW,
	parseAuthEnvironment,
	resolveInheritedAllowlist,
	tinyauthRules,
	main,
	hosts,
	requiredServices,
	serviceDependencies,
	primaryHost,
	rewriteComposeForPreview,
	previewId,
	updateAccess,
} from './preview.js';

const REGEX_MISSING_SERVICE = /Could not find app service "api"/;
const REGEX_UNOWNED_RULE = /unowned/;
const REGEX_MISSING_RULE = /Expected one/;
const REGEX_DIFFERENT_ALLOWLISTS = /different/;
const REGEX_DEFAULT_DENY = /deny/;
const REGEX_RECREATION = /recreation/;
const REGEX_MISSING_AUTH = /missing/;
const REGEX_INVALID_PR_NUMBER = /pr-number must be a positive integer/;
const REGEX_INVALID_DIRECTORY = /directory directly under apps/;
const REGEX_INVALID_ACTION = /action must be create or cleanup/;
const REGEX_REQUIRED_SERVICE = /service-name/;
const REGEX_REQUIRED_PR = /pr-number/;

const SCRIPT_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'preview.js',
);

describe('hosts', function () {
	it('collects all unique hosts from labels', function () {
		const services = {
			app: {
				labels: [
					'traefik.http.routers.app.rule=Host(`closepowerlifting.com`) || Host(`www.closepowerlifting.com`)',
					'traefik.http.routers.app-redirect.rule=Host(`close-powerlifting.jaw.dev`)',
				],
			},
		};
		assert.deepStrictEqual(hosts(services), [
			'closepowerlifting.com',
			'www.closepowerlifting.com',
			'close-powerlifting.jaw.dev',
		]);
	});

	it('deduplicates hosts', function () {
		const services = {
			app: {
				labels: [
					'traefik.http.routers.app.rule=Host(`app.jaw.dev`)',
					'traefik.http.routers.app2.rule=Host(`app.jaw.dev`)',
				],
			},
		};
		assert.deepStrictEqual(hosts(services), ['app.jaw.dev']);
	});

	it('returns empty array when no hosts', function () {
		const services = { app: { labels: ['traefik.enable=true'] } };
		assert.deepStrictEqual(hosts(services), []);
	});
});

describe('primaryHost', function () {
	it('picks jaw.dev subdomain over bare/www domain (closepowerlifting bug)', function () {
		const services = {
			app: {
				labels: [
					'traefik.http.routers.app.rule=Host(`closepowerlifting.com`) || Host(`www.closepowerlifting.com`)',
					'traefik.http.routers.app-redirect.rule=Host(`close-powerlifting.jaw.dev`)',
				],
			},
		};
		assert.strictEqual(primaryHost(services), 'close-powerlifting.jaw.dev');
	});

	it('produces correct temp URL for closepowerlifting', function () {
		const services = {
			app: {
				labels: [
					'traefik.http.routers.app.rule=Host(`closepowerlifting.com`) || Host(`www.closepowerlifting.com`)',
					'traefik.http.routers.app-redirect.rule=Host(`close-powerlifting.jaw.dev`)',
				],
			},
		};
		const host = primaryHost(services);
		const domain = host.split('.').slice(1).join('.');
		const hostname = `pr-148-close-powerlifting.${domain}`;
		assert.strictEqual(hostname, 'pr-148-close-powerlifting.jaw.dev');
	});

	it('works with simple subdomain host (bang.jaw.dev)', function () {
		const services = {
			app: {
				labels: ['traefik.http.routers.bang.rule=Host(`bang.jaw.dev`)'],
			},
		};
		assert.strictEqual(primaryHost(services), 'bang.jaw.dev');
	});

	it('falls back to bare domain if no subdomain exists', function () {
		const services = {
			app: {
				labels: ['traefik.http.routers.app.rule=Host(`example.com`)'],
			},
		};
		assert.strictEqual(primaryHost(services), 'example.com');
	});

	it('returns null when no Host() labels', function () {
		const services = {
			app: { labels: ['traefik.enable=true'] },
		};
		assert.strictEqual(primaryHost(services), null);
	});

	it('returns null when no labels at all', function () {
		const services = {
			app: { image: 'nginx' },
		};
		assert.strictEqual(primaryHost(services), null);
	});

	it('handles multiple services', function () {
		const services = {
			app: {
				labels: ['traefik.http.routers.app.rule=Host(`myapp.com`)'],
			},
			redirect: {
				labels: ['traefik.http.routers.redirect.rule=Host(`app.jaw.dev`)'],
			},
		};
		assert.strictEqual(primaryHost(services), 'app.jaw.dev');
	});
});

describe('serviceDependencies', function () {
	it('reads list syntax', () => {
		assert.deepStrictEqual(
			serviceDependencies({ depends_on: ['db', 'redis'] }),
			['db', 'redis'],
		);
	});

	it('reads condition map syntax', () => {
		assert.deepStrictEqual(
			serviceDependencies({
				depends_on: { db: { condition: 'service_healthy' } },
			}),
			['db'],
		);
	});

	it('ignores missing depends_on', () => {
		assert.deepStrictEqual(serviceDependencies({ image: 'nginx' }), []);
	});
});

describe('requiredServices', function () {
	it('keeps the app service when there are no dependencies', function () {
		const selected = requiredServices(
			{ web: { image: 'nginx' }, worker: { image: 'nginx' } },
			'web',
		);

		assert.deepStrictEqual([...selected].sort(), ['web']);
	});

	it('follows recursive dependencies and skips siblings', function () {
		const selected = requiredServices(
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
		assert.deepStrictEqual(
			[...requiredServices({ db: { image: 'postgres' } }, 'web')],
			[],
		);
	});
});

describe('preview create', function () {
	it('uses service-name as the dependency root and router prefix', function () {
		const result = rewriteComposeForPreview(
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

		assert.deepStrictEqual(Object.keys(result.doc.services).sort(), [
			'api',
			'db',
		]);
		assert.strictEqual(
			result.doc.services.api.image,
			'ghcr.io/wajeht/example:abc1234',
		);
		assert.deepStrictEqual(result.doc.services.api.labels, [
			'traefik.http.routers.api-pr-42.rule=Host(`pr-42-example.jaw.dev`)',
			'traefik.http.services.api-pr-42.loadbalancer.server.port=3000',
		]);
		assert.strictEqual(result.url, 'https://pr-42-example.jaw.dev');
	});

	it('preserves existing middlewares by default', function () {
		const result = rewriteComposeForPreview(
			{
				services: {
					bang: {
						image: 'ghcr.io/wajeht/bang:old',
						labels: [
							'traefik.http.routers.bang.rule=Host(`bang.jaw.dev`)',
							'traefik.http.routers.bang.entrypoints=websecure',
							'traefik.http.routers.bang.middlewares=rate-limit-global@file',
							'traefik.http.services.bang.loadbalancer.server.port=80',
						],
					},
				},
			},
			{
				appName: 'bang',
				serviceName: 'bang',
				tag: 'abc1234',
				prNumber: '42',
				repoOwner: 'wajeht',
			},
		);

		assert.deepStrictEqual(result.doc.services.bang.labels, [
			'traefik.http.routers.bang-pr-42.rule=Host(`pr-42-bang.jaw.dev`)',
			'traefik.http.routers.bang-pr-42.entrypoints=websecure',
			'traefik.http.routers.bang-pr-42.middlewares=rate-limit-global@file',
			'traefik.http.services.bang-pr-42.loadbalancer.server.port=80',
		]);
	});

	it('rewrites router names that differ from service-name', function () {
		const result = rewriteComposeForPreview(
			{
				services: {
					www: {
						image: 'ghcr.io/wajeht/jaw.dev:old',
						labels: [
							'traefik.http.routers.jaw-dev.rule=Host(`jaw.dev`) || Host(`www.jaw.dev`)',
							'traefik.http.routers.jaw-dev.entrypoints=websecure',
							'traefik.http.routers.jaw-dev.middlewares=rate-limit-global@file',
							'traefik.http.services.jaw-dev.loadbalancer.server.port=80',
						],
					},
				},
			},
			{
				appName: 'jaw-dev',
				serviceName: 'www',
				tag: 'abc1234',
				prNumber: '38',
				repoOwner: 'wajeht',
				authMiddleware: 'oauth2-admin@file',
			},
		);

		assert.deepStrictEqual(result.doc.services.www.labels, [
			'traefik.http.routers.jaw-dev-pr-38.rule=Host(`pr-38-jaw-dev.jaw.dev`) || Host(`pr-38-jaw-dev.jaw.dev`)',
			'traefik.http.routers.jaw-dev-pr-38.entrypoints=websecure',
			'traefik.http.routers.jaw-dev-pr-38.middlewares=oauth2-admin@file',
			'traefik.http.services.jaw-dev-pr-38.loadbalancer.server.port=80',
		]);
	});

	it('replaces existing router middlewares when auth-middleware is set', function () {
		const result = rewriteComposeForPreview(
			{
				services: {
					bang: {
						image: 'ghcr.io/wajeht/bang:old',
						labels: [
							'traefik.http.routers.bang.rule=Host(`bang.jaw.dev`)',
							'traefik.http.routers.bang.entrypoints=websecure',
							'traefik.http.routers.bang.middlewares=rate-limit-global@file',
							'traefik.http.services.bang.loadbalancer.server.port=80',
						],
					},
				},
			},
			{
				appName: 'bang',
				serviceName: 'bang',
				tag: 'abc1234',
				prNumber: '42',
				repoOwner: 'wajeht',
				authMiddleware: 'oauth2-admin@file',
			},
		);

		assert.deepStrictEqual(result.doc.services.bang.labels, [
			'traefik.http.routers.bang-pr-42.rule=Host(`pr-42-bang.jaw.dev`)',
			'traefik.http.routers.bang-pr-42.entrypoints=websecure',
			'traefik.http.routers.bang-pr-42.middlewares=oauth2-admin@file',
			'traefik.http.services.bang-pr-42.loadbalancer.server.port=80',
		]);
	});

	it('adds router middlewares when auth-middleware is set and no middleware label exists', function () {
		const result = rewriteComposeForPreview(
			{
				services: {
					demo: {
						image: 'ghcr.io/wajeht/demo:old',
						labels: [
							'traefik.http.routers.demo.rule=Host(`demo.jaw.dev`)',
							'traefik.http.routers.demo.entrypoints=websecure',
							'traefik.http.services.demo.loadbalancer.server.port=3000',
						],
					},
				},
			},
			{
				appName: 'demo',
				serviceName: 'demo',
				tag: 'abc1234',
				prNumber: '42',
				repoOwner: 'wajeht',
				authMiddleware: 'oauth2-admin@file',
			},
		);

		assert.deepStrictEqual(result.doc.services.demo.labels, [
			'traefik.http.routers.demo-pr-42.rule=Host(`pr-42-demo.jaw.dev`)',
			'traefik.http.routers.demo-pr-42.entrypoints=websecure',
			'traefik.http.services.demo-pr-42.loadbalancer.server.port=3000',
			'traefik.http.routers.demo-pr-42.middlewares=oauth2-admin@file',
		]);
	});

	it('applies auth-middleware to each rewritten router on the service', function () {
		const result = rewriteComposeForPreview(
			{
				services: {
					homeassistant: {
						image: 'ghcr.io/wajeht/homeassistant:old',
						labels: [
							'traefik.http.routers.homeassistant.rule=Host(`ha.jaw.dev`)',
							'traefik.http.routers.homeassistant.middlewares=oauth2-admin@file',
							'traefik.http.routers.homeassistant-app.rule=Host(`ha-app.jaw.dev`)',
							'traefik.http.routers.homeassistant-app.middlewares=rate-limit-global@file',
							'traefik.http.services.homeassistant.loadbalancer.server.port=8123',
						],
					},
				},
			},
			{
				appName: 'homeassistant',
				serviceName: 'homeassistant',
				tag: 'abc1234',
				prNumber: '42',
				repoOwner: 'wajeht',
				authMiddleware: 'oauth2-admin@file',
			},
		);

		assert.deepStrictEqual(result.doc.services.homeassistant.labels, [
			'traefik.http.routers.homeassistant-pr-42.rule=Host(`pr-42-homeassistant.jaw.dev`)',
			'traefik.http.routers.homeassistant-pr-42.middlewares=oauth2-admin@file',
			'traefik.http.routers.homeassistant-pr-42-app.rule=Host(`pr-42-homeassistant.jaw.dev`)',
			'traefik.http.routers.homeassistant-pr-42-app.middlewares=oauth2-admin@file',
			'traefik.http.services.homeassistant-pr-42.loadbalancer.server.port=8123',
		]);
	});

	it('ignores blank auth-middleware values', function () {
		const result = rewriteComposeForPreview(
			{
				services: {
					bang: {
						image: 'ghcr.io/wajeht/bang:old',
						labels: [
							'traefik.http.routers.bang.rule=Host(`bang.jaw.dev`)',
							'traefik.http.routers.bang.middlewares=rate-limit-global@file',
						],
					},
				},
			},
			{
				appName: 'bang',
				serviceName: 'bang',
				tag: 'abc1234',
				prNumber: '42',
				repoOwner: 'wajeht',
				authMiddleware: '   ',
			},
		);

		assert.deepStrictEqual(result.doc.services.bang.labels, [
			'traefik.http.routers.bang-pr-42.rule=Host(`pr-42-bang.jaw.dev`)',
			'traefik.http.routers.bang-pr-42.middlewares=rate-limit-global@file',
		]);
	});

	it('fails when service-name is not present', () => {
		assert.throws(
			() =>
				rewriteComposeForPreview(
					{ services: { web: { image: 'nginx' } } },
					{
						appName: 'example',
						serviceName: 'api',
						tag: 'abc1234',
						prNumber: '42',
						repoOwner: 'wajeht',
					},
				),
			REGEX_MISSING_SERVICE,
		);
	});

	it('keeps the app service and its dependencies only', function () {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'docker-cd-deploy-workflow-'),
		);
		const appPath = path.join(tempDir, 'apps', 'demo');
		const tempPath = `${appPath}-pr-42`;

		try {
			fs.mkdirSync(appPath, { recursive: true });
			fs.writeFileSync(
				path.join(appPath, 'docker-compose.yml'),
				yaml.dump({
					'x-docker-cd': {
						rolling_update: true,
					},
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
				SCRIPT_PATH,
				'--action',
				'create',
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

			const rewritten = yaml.load(
				fs.readFileSync(path.join(tempPath, 'docker-compose.yml'), 'utf8'),
			);

			assert.deepStrictEqual(rewritten['x-docker-cd'], {
				rolling_update: false,
			});
			assert.deepStrictEqual(Object.keys(rewritten.services).sort(), [
				'demo',
				'demo-db',
			]);
			assert.strictEqual(
				rewritten.services.demo.image,
				'ghcr.io/wajeht/demo:abc1234',
			);
			assert.strictEqual(
				rewritten.services['demo-db'].container_name,
				undefined,
			);
			assert.deepStrictEqual(Object.keys(rewritten.networks).sort(), [
				'internal',
				'traefik',
			]);
			assert.deepStrictEqual(Object.keys(rewritten.volumes), ['db']);
			assert.strictEqual(
				rewritten.services.demo.labels[1],
				'traefik.http.routers.demo-pr-42.rule=Host(`pr-42-demo.jaw.dev`)',
			);
			assert.strictEqual(
				fs.existsSync(path.join(tempPath, 'docker-cd.yml')),
				false,
			);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('passes auth-middleware through the CLI', function () {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'docker-cd-deploy-workflow-'),
		);
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
							labels: [
								'traefik.http.routers.demo.rule=Host(`demo.jaw.dev`)',
								'traefik.http.routers.demo.middlewares=rate-limit-global@file',
								'traefik.http.services.demo.loadbalancer.server.port=3000',
							],
						},
					},
				}),
			);

			execFileSync('node', [
				SCRIPT_PATH,
				'--action',
				'create',
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
				'--auth-middleware',
				'oauth2-admin@file',
			]);

			const rewritten = yaml.load(
				fs.readFileSync(path.join(tempPath, 'docker-compose.yml'), 'utf8'),
			);

			assert.deepStrictEqual(rewritten.services.demo.labels, [
				'traefik.http.routers.demo-pr-42.rule=Host(`pr-42-demo.jaw.dev`)',
				'traefik.http.routers.demo-pr-42.middlewares=oauth2-admin@file',
				'traefik.http.services.demo-pr-42.loadbalancer.server.port=3000',
			]);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

const PREVIEW_CONFIG = `x-docker-cd:
  rolling_update: false
services:
  tinyauth:
    # lint-ignore: backup
    image: tinyauth:v5
    environment:
      TINYAUTH_AUTH_ACLS_POLICY: deny
      TINYAUTH_APPS_ADMIN_CONFIG_DOMAIN: admin.example.com
      TINYAUTH_APPS_ADMIN_OAUTH_WHITELIST: \${TINYAUTH_ADMIN_ALLOW:?required}
      TINYAUTH_APPS_USERS_CONFIG_DOMAIN: users.example.com
      TINYAUTH_APPS_USERS_OAUTH_WHITELIST: \${TINYAUTH_USERS_ALLOW:?required}
      TZ: America/Chicago
`;
const PREVIEW_OPTIONS = {
	appPath: 'apps/demo',
	prNumber: '42',
	hostname: 'pr-42-demo.example.com',
	allowlist: ADMIN_ALLOW,
};
function app(host = 'admin.example.com', middleware = 'tinyauth@file') {
	return {
		services: {
			demo: {
				image: 'ghcr.io/test/demo:old',
				labels: [
					`traefik.http.routers.demo.rule=Host(\`${host}\`)`,
					`traefik.http.routers.demo.middlewares=${middleware}`,
				],
			},
		},
	};
}

describe('preview access rules', function () {
	it('registers exactly one OAuth rule and preserves all production text', function () {
		const result = updateAccess(PREVIEW_CONFIG, PREVIEW_OPTIONS);
		const env = parseAuthEnvironment(result);
		const id = previewId(PREVIEW_OPTIONS.appPath, PREVIEW_OPTIONS.prNumber);
		assert.equal(
			env[`TINYAUTH_APPS_${id}_CONFIG_DOMAIN`],
			PREVIEW_OPTIONS.hostname,
		);
		assert.equal(env[`TINYAUTH_APPS_${id}_OAUTH_WHITELIST`], ADMIN_ALLOW);
		assert.equal(
			updateAccess(result, { ...PREVIEW_OPTIONS, allowlist: null }),
			PREVIEW_CONFIG,
		);
		assert.equal(updateAccess(result, PREVIEW_OPTIONS), result);
		assert.ok(!result.includes('BASICAUTH'));
	});
	it('removes only the owned rule and rejects an unowned collision', function () {
		const other = {
			...PREVIEW_OPTIONS,
			prNumber: '43',
			hostname: 'pr-43-demo.example.com',
		};
		const second = updateAccess(PREVIEW_CONFIG, other);
		const both = updateAccess(second, PREVIEW_OPTIONS);
		assert.equal(
			updateAccess(both, { ...PREVIEW_OPTIONS, allowlist: null }),
			second,
		);
		const unowned = updateAccess(PREVIEW_CONFIG, PREVIEW_OPTIONS).replace(
			PREVIEW_OPTIONS.hostname,
			'production.example.com',
		);
		assert.throws(
			() => updateAccess(unowned, PREVIEW_OPTIONS),
			REGEX_UNOWNED_RULE,
		);
	});
	it('inherits admin and users allowlists, including middleware chains and map labels', function () {
		const env = parseAuthEnvironment(PREVIEW_CONFIG);
		assert.equal(
			resolveInheritedAllowlist(tinyauthRules(app().services), env),
			ADMIN_ALLOW,
		);
		const users = app(
			'users.example.com',
			'rate-limit@file,tinyauth-no-ratelimit@file',
		);
		const labels = {};
		for (const label of users.services.demo.labels) {
			const [key, value] = label.split('=');
			labels[key] = value;
		}
		const usersWithMapLabels = {
			services: { demo: { ...users.services.demo, labels } },
		};
		assert.equal(
			resolveInheritedAllowlist(
				tinyauthRules(usersWithMapLabels.services),
				env,
			),
			USERS_ALLOW,
		);
		assert.equal(
			resolveInheritedAllowlist(
				tinyauthRules(app('users.example.com', 'rate-limit@file').services),
				env,
			),
			null,
		);
		assert.throws(
			() =>
				resolveInheritedAllowlist(
					tinyauthRules(app('unknown.example.com').services),
					env,
				),
			REGEX_MISSING_RULE,
		);
		assert.throws(
			() =>
				resolveInheritedAllowlist(
					tinyauthRules({
						...app().services,
						users: app('users.example.com').services.demo,
					}),
					env,
				),
			REGEX_DIFFERENT_ALLOWLISTS,
		);
	});
	it('fails closed for default allow or rolling updates', function () {
		assert.throws(
			() =>
				parseAuthEnvironment(
					PREVIEW_CONFIG.replace('POLICY: deny', 'POLICY: allow'),
				),
			REGEX_DEFAULT_DENY,
		);
		assert.throws(
			() =>
				parseAuthEnvironment(
					PREVIEW_CONFIG.replace(
						'rolling_update: false',
						'rolling_update: true',
					),
				),
			REGEX_RECREATION,
		);
	});
	it('handles inherited auth, explicit admin, public transitions, and cleanup after a missing stack', async function () {
		const cwd = process.cwd();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-access-'));
		try {
			process.chdir(dir);
			fs.mkdirSync('apps/tinyauth', { recursive: true });
			fs.mkdirSync('apps/demo', { recursive: true });
			fs.writeFileSync('apps/tinyauth/docker-compose.yml', PREVIEW_CONFIG);
			async function deployPreview(doc, middleware = '') {
				fs.writeFileSync('apps/demo/docker-compose.yml', yaml.dump(doc));
				return main([
					'--action',
					'create',
					'--app-path',
					'apps/demo',
					'--service-name',
					'demo',
					'--pr-number',
					'42',
					'--tag',
					'new',
					'--repo-owner',
					'test',
					'--auth-middleware',
					middleware,
				]);
			}
			function readConfig() {
				return fs.readFileSync('apps/tinyauth/docker-compose.yml', 'utf8');
			}
			const key = `TINYAUTH_APPS_${previewId('apps/demo', '42')}_OAUTH_WHITELIST`;
			await deployPreview(app('users.example.com'));
			assert.equal(parseAuthEnvironment(readConfig())[key], USERS_ALLOW);
			await deployPreview(app('users.example.com'), 'tinyauth@file');
			assert.equal(parseAuthEnvironment(readConfig())[key], ADMIN_ALLOW);
			await deployPreview(app('users.example.com', 'rate-limit@file'));
			assert.equal(readConfig(), PREVIEW_CONFIG);
			await deployPreview(
				app('users.example.com', 'rate-limit@file'),
				'tinyauth@file',
			);
			fs.rmSync('apps/demo-pr-42', { recursive: true });
			await main([
				'--action',
				'cleanup',
				'--app-path',
				'apps/demo/.',
				'--pr-number',
				'42',
			]);
			await main([
				'--action',
				'cleanup',
				'--app-path',
				'apps/demo',
				'--pr-number',
				'42',
			]);
			assert.equal(readConfig(), PREVIEW_CONFIG);
			fs.rmSync('apps/tinyauth', { recursive: true });
			await assert.rejects(() => deployPreview(app()), REGEX_MISSING_AUTH);
		} finally {
			process.chdir(cwd);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('preview cleanup', function () {
	it('removes the matching temp stack', async function () {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'docker-cd-deploy-workflow-'),
		);
		const appPath = path.join(dir, 'apps', 'demo');
		const tempPath = `${appPath}-pr-42`;

		try {
			fs.mkdirSync(tempPath, { recursive: true });
			fs.writeFileSync(
				path.join(tempPath, 'docker-compose.yml'),
				'services: {}\n',
			);

			execFileSync(process.execPath, [
				SCRIPT_PATH,
				'--action',
				'cleanup',
				'--app-path',
				`${appPath}${path.sep}`,
				'--pr-number',
				'42',
			]);

			assert.strictEqual(fs.existsSync(tempPath), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('does nothing when the temp stack is already gone', async function () {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'docker-cd-deploy-workflow-'),
		);
		const appPath = path.join(dir, 'apps', 'demo');

		try {
			await main([
				'--action',
				'cleanup',
				'--app-path',
				appPath,
				'--pr-number',
				'42',
			]);

			assert.strictEqual(fs.existsSync(`${appPath}-pr-42`), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('preview input boundaries', function () {
	it('rejects unsafe deletion targets before touching files', async function () {
		for (const prNumber of ['../42', '0', '-1']) {
			await assert.rejects(
				() =>
					main([
						'--action',
						'cleanup',
						'--app-path',
						'apps/demo',
						`--pr-number=${prNumber}`,
					]),
				REGEX_INVALID_PR_NUMBER,
			);
		}
		await assert.rejects(
			() =>
				main(['--action', 'cleanup', '--app-path', '.', '--pr-number', '42']),
			REGEX_INVALID_DIRECTORY,
		);
	});

	it('keeps the production Compose input unchanged', function () {
		const production = app();
		production.services.demo.container_name = 'production';
		production.services.demo.volumes = ['/home/jaw/data/demo:/data'];
		const snapshot = structuredClone(production);
		const preview = rewriteComposeForPreview(production, {
			appName: 'demo',
			serviceName: 'demo',
			tag: 'new',
			prNumber: '42',
			repoOwner: 'test',
		});
		assert.deepStrictEqual(production, snapshot);
		assert.notStrictEqual(preview.doc.services.demo, production.services.demo);
	});
});

describe('preview CLI', () => {
	it('validates the action and creation-only arguments', async function () {
		await assert.rejects(() => main([]), REGEX_INVALID_ACTION);
		await assert.rejects(
			() => main(['--action', 'invalid']),
			REGEX_INVALID_ACTION,
		);
		await assert.rejects(
			() =>
				main([
					'--action',
					'create',
					'--app-path',
					'apps/demo',
					'--pr-number',
					'42',
				]),
			REGEX_REQUIRED_SERVICE,
		);
		await assert.rejects(
			() => main(['--action', 'cleanup', '--app-path', 'apps/demo']),
			REGEX_REQUIRED_PR,
		);
	});
});

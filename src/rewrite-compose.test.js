import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rewrite-compose.js');

describe('rewrite-compose', () => {
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

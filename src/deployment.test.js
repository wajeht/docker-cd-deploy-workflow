import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, waitForTinyauth } from './deployment.js';

function fakeFetch(responses) {
	const calls = [];
	async function fetch(url, options = {}) {
		const response = responses.shift() || {};
		calls.push({
			url,
			method: options.method || 'GET',
			body: options.body ? JSON.parse(options.body) : null,
		});
		return {
			ok: response.ok ?? true,
			status: response.status ?? 200,
			async json() {
				return response.json ?? {};
			},
			async text() {
				return response.text ?? '';
			},
		};
	}
	fetch.calls = calls;
	return fetch;
}

function withFetch(t, fetch) {
	const previous = globalThis.fetch;
	globalThis.fetch = fetch;
	t.after(() => {
		globalThis.fetch = previous;
	});
}

function withDockerCd(t) {
	const values = {
		DOCKER_CD_URL: 'https://cd.example.com',
		DOCKER_CD_API_SECRET: 'test',
	};
	for (const [key, value] of Object.entries(values)) {
		const previous = process.env[key];
		process.env[key] = value;
		t.after(() => {
			if (previous === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = previous;
			}
		});
	}
}

function withGithubOutput(t) {
	const previous = process.env.GITHUB_OUTPUT;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-cd-deploy-workflow-'));
	const outputFile = path.join(dir, 'output');
	process.env.GITHUB_OUTPUT = outputFile;
	t.after(() => {
		if (previous === undefined) {
			delete process.env.GITHUB_OUTPUT;
		} else {
			process.env.GITHUB_OUTPUT = previous;
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return outputFile;
}

describe('deployment', () => {
	it('requests a deployment and writes the deployment id output', async (t) => {
		const fetch = fakeFetch([{ json: { id: 123 } }, {}]);
		const outputFile = withGithubOutput(t);
		withFetch(t, fetch);

		await main([
			'--token',
			'token',
			'--repo',
			'wajeht/app',
			'--action',
			'request',
			'--environment',
			'temp/pr-1',
			'--ref',
			'feature',
		]);

		assert.deepStrictEqual(fetch.calls, [
			{
				url: 'https://api.github.com/repos/wajeht/app/deployments',
				method: 'POST',
				body: {
					ref: 'feature',
					environment: 'temp/pr-1',
					auto_merge: false,
					required_contexts: [],
					transient_environment: true,
					production_environment: false,
				},
			},
			{
				url: 'https://api.github.com/repos/wajeht/app/deployments/123/statuses',
				method: 'POST',
				body: {
					state: 'in_progress',
					description: 'Deploying temp environment',
				},
			},
		]);
		assert.strictEqual(fs.readFileSync(outputFile, 'utf8'), 'deployment-id=123\n');
	});

	it('marks a deployment successful without polling when health check is skipped', async (t) => {
		const fetch = fakeFetch([{}]);
		withFetch(t, fetch);

		await main([
			'--token',
			'token',
			'--repo',
			'wajeht/app',
			'--action',
			'deploy',
			'--environment',
			'temp/pr-1',
			'--deployment-id',
			'123',
			'--url',
			'https://pr-1-app.jaw.dev',
			'--skip-health-check',
			'true',
		]);

		assert.deepStrictEqual(fetch.calls, [
			{
				url: 'https://api.github.com/repos/wajeht/app/deployments/123/statuses',
				method: 'POST',
				body: {
					state: 'success',
					environment_url: 'https://pr-1-app.jaw.dev',
					description: 'Deploy committed, docker-cd will pick it up',
				},
			},
		]);
	});

	it('cleans up all deployments for an environment', async (t) => {
		const fetch = fakeFetch([{ json: [{ id: 1 }, { id: 2 }] }, {}, {}, {}, {}]);
		withFetch(t, fetch);

		await main(['--token', 'token', '--repo', 'wajeht/app', '--action', 'cleanup', '--environment', 'temp/pr-1']);

		assert.deepStrictEqual(fetch.calls, [
			{
				url: 'https://api.github.com/repos/wajeht/app/deployments?environment=temp%2Fpr-1&per_page=100',
				method: 'GET',
				body: null,
			},
			{
				url: 'https://api.github.com/repos/wajeht/app/deployments/1/statuses',
				method: 'POST',
				body: {
					state: 'inactive',
					description: 'Temp deploy removed',
				},
			},
			{
				url: 'https://api.github.com/repos/wajeht/app/deployments/1',
				method: 'DELETE',
				body: null,
			},
			{
				url: 'https://api.github.com/repos/wajeht/app/deployments/2/statuses',
				method: 'POST',
				body: {
					state: 'inactive',
					description: 'Temp deploy removed',
				},
			},
			{
				url: 'https://api.github.com/repos/wajeht/app/deployments/2',
				method: 'DELETE',
				body: null,
			},
		]);
	});

	it('surfaces GitHub API errors', async (t) => {
		const fetch = fakeFetch([{ ok: false, status: 500, text: 'nope' }]);
		withFetch(t, fetch);

		await assert.rejects(
			() => main(['--token', 'token', '--repo', 'wajeht/app', '--action', 'cleanup', '--environment', 'temp/pr-1']),
			/GitHub API GET \/deployments\?environment=temp%2Fpr-1&per_page=100: 500 nope/,
		);
	});

	it('checks deployed state instead of accepting a login page', async (t) => {
		withDockerCd(t);
		const ready = {
			sync: 'synced',
			lastDeploy: { status: 'synced', commitSHA: 'a'.repeat(40) },
			health: { total: 1, running: 1, healthy: 1, starting: 0, unhealthy: 0 },
		};
		const options = { attempts: 1, matches: () => true };
		withFetch(t, async (url, request) => {
			assert.strictEqual(request.redirect, 'error');
			assert.strictEqual(request.headers.Authorization, 'Bearer test');
			return Response.json({ success: true, data: ready });
		});
		await waitForTinyauth('apps/demo-pr-42', options);
		await assert.rejects(
			() =>
				waitForTinyauth('apps/demo-pr-42', {
					...options,
					matches: () => false,
				}),
			/Timed out/,
		);
		for (const data of [
			{ ...ready, lastDeploy: { status: 'failed' } },
			{ ...ready, health: { ...ready.health, starting: 1 } },
		]) {
			globalThis.fetch = async () => Response.json({ success: true, data });
			await assert.rejects(
				() => waitForTinyauth('apps/demo-pr-42', options),
				/Timed out/,
			);
		}
		globalThis.fetch = async () => new Response('<html>login</html>');
		await assert.rejects(
			() => waitForTinyauth('apps/demo-pr-42', options),
			/Timed out/,
		);
		globalThis.fetch = async () => new Response('', { status: 401 });
		await assert.rejects(
			() => waitForTinyauth('apps/demo-pr-42', options),
			/authentication/,
		);
	});

	it('parses folded middleware labels and records protected deployment failures', async (t) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-readiness-'));
		withDockerCd(t);
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		fs.writeFileSync(
			path.join(dir, 'docker-compose.yml'),
			`services:
  web:
    labels:
      traefik.http.routers.web.middlewares: >-
        tinyauth@file
`,
		);
		const fetch = fakeFetch([{ ok: false, status: 401 }, {}]);
		withFetch(t, fetch);
		const args = [
			'--token',
			'test',
			'--repo',
			'wajeht/app',
			'--action',
			'deploy',
			'--environment',
			'pr-42',
			'--deployment-id',
			'123',
			'--url',
			'https://pr-42.example.com',
			'--app-path',
			dir,
			'--skip-health-check',
			'true',
		];
		await assert.rejects(() => main(args), /authentication/);
		assert.strictEqual(fetch.calls[1].body.state, 'failure');

		// Comments mentioning the middleware must not turn a public preview into a protected one.
		fs.writeFileSync(
			path.join(dir, 'docker-compose.yml'),
			'services:\n  web:\n    # middlewares=tinyauth@file\n    image: nginx\n',
		);
		const publicFetch = fakeFetch([{}]);
		globalThis.fetch = publicFetch;
		await main(args);
		assert.strictEqual(publicFetch.calls.length, 1);
		assert.strictEqual(publicFetch.calls[0].body.state, 'success');
	});
});

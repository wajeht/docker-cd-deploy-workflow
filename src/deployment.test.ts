import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from './deployment.ts';

type FakeResponse = {
	ok?: boolean;
	status?: number;
	json?: unknown;
	text?: string;
};

type FetchCall = {
	url: string | URL | Request;
	method: string;
	body: unknown;
};

type FakeFetch = ((url: string | URL | Request, options?: RequestInit) => Promise<Response>) & {
	calls: FetchCall[];
};

function fakeFetch(responses: FakeResponse[]): FakeFetch {
	const calls: FetchCall[] = [];
	async function fetchMock(url: string | URL | Request, options: RequestInit = {}) {
		const response = responses.shift() || {};
		calls.push({
			url,
			method: options.method || 'GET',
			body: typeof options.body === 'string' ? JSON.parse(options.body) : null,
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
		} as Response;
	}
	fetchMock.calls = calls;
	return fetchMock;
}

function withFetch(t: TestContext, fetchMock: FakeFetch): void {
	const previous = globalThis.fetch;
	globalThis.fetch = fetchMock;
	t.after(() => {
		globalThis.fetch = previous;
	});
}

function withGithubOutput(t: TestContext): string {
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
});

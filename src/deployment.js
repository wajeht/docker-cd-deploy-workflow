import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { authPath, previewId, isTinyauthPreview } from './preview.js';

function createGitHubApi(token, repo) {
	const apiBase = `https://api.github.com/repos/${repo}`;
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'Content-Type': 'application/json',
		'X-GitHub-Api-Version': '2022-11-28',
	};

	return async function githubApi(path, options = {}) {
		const res = await fetch(`${apiBase}${path}`, { headers, ...options });
		if (!res.ok) {
			throw new Error(`GitHub API ${options.method || 'GET'} ${path}: ${res.status} ${await res.text()}`);
		}
		return res;
	};
}

async function requestDeployment(githubApi, args) {
	const environment = args['environment'];
	const ref = args['ref'] || 'main';
	const production = args['production'] === 'true';
	const res = await githubApi('/deployments', {
		method: 'POST',
		body: JSON.stringify({
			ref,
			environment,
			auto_merge: false,
			required_contexts: [],
			transient_environment: !production,
			production_environment: production,
		}),
	});
	const deployment = await res.json();

	await githubApi(`/deployments/${deployment.id}/statuses`, {
		method: 'POST',
		body: JSON.stringify({
			state: 'in_progress',
			description: 'Deploying temp environment',
		}),
	});

	console.log(`Requested deployment ${deployment.id} for ${environment}`);

	const outputFile = process.env.GITHUB_OUTPUT;
	if (outputFile) {
		fs.appendFileSync(outputFile, `deployment-id=${deployment.id}\n`);
	}
}

function git(args) {
	return execFileSync('git', args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

export function deployedRevisionMatches(
	expected,
	actual,
	tempPath,
	auth = false,
) {
	if (!/^[a-f0-9]{40}$/.test(actual || '')) {
		return false;
	}
	try {
		try {
			git(['cat-file', '-e', actual]);
		} catch {
			git(['fetch', 'origin', 'main']);
		}
		git(['merge-base', '--is-ancestor', expected, actual]);
		if (!auth) {
			return (
				git(['diff', '--name-only', expected, actual, '--', tempPath]) === ''
			);
		}
		const [, app, pr] = path.basename(tempPath).match(/^(.+)-pr-([0-9]+)$/);
		const ownKey = `TINYAUTH_APPS_${previewId(app, pr)}_`;
		const settings = (ref) =>
			git(['show', `${ref}:${authPath}`])
				.split('\n')
				.filter((line) => {
					return (
						!line.trim().startsWith('TINYAUTH_APPS_PREVIEW') ||
						line.trim().startsWith(ownKey)
					);
				})
				.join('\n');
		// Other previews may change; our rule and the rest of Tinyauth must still match.
		return settings(expected) === settings(actual);
	} catch {
		return false;
	}
}

export async function waitForTinyauth(
	tempPath,
	{
		attempts = 60,
		matches = deployedRevisionMatches,
	} = {},
) {
	const apiUrl = process.env.DOCKER_CD_URL;
	const token = process.env.DOCKER_CD_API_SECRET;
	if (!apiUrl || !token) {
		throw new Error(
			'Tinyauth previews require DOCKER_CD_URL and DOCKER_CD_API_SECRET',
		);
	}
	const api = new URL(apiUrl);
	if (api.protocol !== 'https:' || api.username || api.password) {
		throw new Error('DOCKER_CD_URL must use HTTPS without URL credentials');
	}
	const expected = git(['rev-parse', 'HEAD']);

	async function projectReady(project) {
		try {
			const response = await fetch(
				new URL(`/api/projects/${encodeURIComponent(project)}`, api),
				{
					headers: { Authorization: `Bearer ${token}` },
					redirect: 'error',
					signal: AbortSignal.timeout(5000),
				},
			);
			if (response.status === 401 || response.status === 403) {
				throw new Error('docker-cd API authentication failed');
			}
			if (!response.ok) {
				return false;
			}
			const { success, data } = await response.json();
			const health = data?.health;
			return (
				success &&
				data?.sync === 'synced' &&
				data.lastDeploy?.status === 'synced' &&
				health?.total > 0 &&
				health.running === health.total &&
				health.starting === 0 &&
				health.unhealthy === 0 &&
				(project !== 'tinyauth' || health.healthy === health.total) &&
				matches(
					expected,
					data.lastDeploy.commitSHA,
					tempPath,
					project === 'tinyauth',
				)
			);
		} catch (error) {
			if (error.message === 'docker-cd API authentication failed') {
				throw error;
			}
			return false;
		}
	}

	const deadline = Date.now() + 600000;
	for (
		let attempt = 0;
		attempt < attempts && Date.now() < deadline;
		attempt++
	) {
		if (
			(await projectReady('tinyauth')) &&
			(await projectReady(path.basename(tempPath)))
		) {
			return;
		}
		if (attempt + 1 < attempts) {
			await new Promise((resolve) => setTimeout(resolve, 10000));
		}
	}
	throw new Error(
		'Timed out waiting for the preview and Tinyauth configuration to deploy',
	);
}

async function markDeploymentSuccess(githubApi, args) {
	const environment = args['environment'];
	const url = args['url'];
	const deploymentId = args['deployment-id'];
	const skipHealthCheck = args['skip-health-check'] === 'true';
	if (!url || !deploymentId) {
		throw new Error('--url and --deployment-id are required for deploy action');
	}

	let protectedPreview = false;
	if (args['app-path']) {
		protectedPreview = isTinyauthPreview(args['app-path']);
	}

	let description;
	if (protectedPreview) {
		try {
			await waitForTinyauth(args['app-path']);
		} catch (error) {
			await githubApi(`/deployments/${deploymentId}/statuses`, {
				method: 'POST',
				body: JSON.stringify({
					state: 'failure',
					description: 'Preview or Tinyauth deployment failed',
				}),
			});
			throw error;
		}
		description = 'Temp deploy is ready';
	} else if (skipHealthCheck) {
		description = 'Deploy committed, docker-cd will pick it up';
		console.log(description);
	} else {
		let healthy = false;
		console.log(`Waiting up to 120s for ${url}...`);
		for (let i = 1; i <= 24; i++) {
			try {
				const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
				console.log(`Attempt ${i}/24: HTTP ${res.status}`);
				if (res.ok) {
					healthy = true;
					break;
				}
			} catch {
				console.log(`Attempt ${i}/24: not reachable`);
			}
			if (i < 24) {
				await new Promise((r) => setTimeout(r, 5000));
			}
		}
		description = healthy
			? 'Temp deploy is ready'
			: 'Temp deploy will be ready in a few seconds';
		console.log(description);
	}

	await githubApi(`/deployments/${deploymentId}/statuses`, {
		method: 'POST',
		body: JSON.stringify({
			state: 'success',
			environment_url: url,
			description,
		}),
	});

	console.log(`Deployment ${deploymentId} for ${environment} -> ${url}`);
}

async function cleanupDeployments(githubApi, args) {
	const environment = args['environment'];
	const res = await githubApi(`/deployments?environment=${encodeURIComponent(environment)}&per_page=100`);
	const deployments = await res.json();

	for (const deployment of deployments) {
		await githubApi(`/deployments/${deployment.id}/statuses`, {
			method: 'POST',
			body: JSON.stringify({
				state: 'inactive',
				description: 'Temp deploy removed',
			}),
		});

		await githubApi(`/deployments/${deployment.id}`, {
			method: 'DELETE',
		});
	}

	console.log(`Cleaned up ${deployments.length} deployment(s) for ${environment}`);
}

export async function main(argv = process.argv.slice(2)) {
	const { values: args } = parseArgs({
		args: argv,
		options: {
			token: { type: 'string' },
			repo: { type: 'string' },
			action: { type: 'string' },
			environment: { type: 'string' },
			ref: { type: 'string' },
			production: { type: 'string' },
			url: { type: 'string' },
			'deployment-id': { type: 'string' },
			'skip-health-check': { type: 'string' },
			'app-path': { type: 'string' },
		},
	});
	for (const key of ['token', 'repo', 'action', 'environment']) {
		if (!args[key]) throw new Error(`Missing required arg: --${key}`);
	}
	const action = args['action'];
	const githubApi = createGitHubApi(args['token'], args['repo']);

	if (action === 'request') {
		await requestDeployment(githubApi, args);
	} else if (action === 'deploy') {
		await markDeploymentSuccess(githubApi, args);
	} else if (action === 'cleanup') {
		await cleanupDeployments(githubApi, args);
	} else {
		throw new Error(`Unknown action: ${action}`);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main().catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
}

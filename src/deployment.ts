import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

type GitHubApi = (apiPath: string, options?: RequestInit) => Promise<Response>;

type GitHubDeployment = {
	id: number;
};

type DeploymentArgs = {
	token?: string;
	repo?: string;
	action?: string;
	environment?: string;
	ref?: string;
	production?: string;
	url?: string;
	'deployment-id'?: string;
	'skip-health-check'?: string;
};

function requireArg(args: DeploymentArgs, key: keyof DeploymentArgs): string {
	const value = args[key];
	if (!value) throw new Error(`Missing required arg: --${key}`);
	return value;
}

function createGitHubApi(token: string, repo: string): GitHubApi {
	const apiBase = `https://api.github.com/repos/${repo}`;
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'Content-Type': 'application/json',
		'X-GitHub-Api-Version': '2022-11-28',
	};

	return async function githubApi(apiPath: string, options: RequestInit = {}) {
		const res = await fetch(`${apiBase}${apiPath}`, { headers, ...options });
		if (!res.ok) {
			throw new Error(`GitHub API ${options.method || 'GET'} ${apiPath}: ${res.status} ${await res.text()}`);
		}
		return res;
	};
}

async function requestDeployment(githubApi: GitHubApi, args: DeploymentArgs): Promise<void> {
	const environment = requireArg(args, 'environment');
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
	const deployment = (await res.json()) as GitHubDeployment;

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

async function markDeploymentSuccess(githubApi: GitHubApi, args: DeploymentArgs): Promise<void> {
	const environment = requireArg(args, 'environment');
	const url = args['url'];
	const deploymentId = args['deployment-id'];
	const skipHealthCheck = args['skip-health-check'] === 'true';
	if (!url || !deploymentId) {
		throw new Error('--url and --deployment-id are required for deploy action');
	}

	let description;
	if (skipHealthCheck) {
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
			if (i < 24) await new Promise((r) => setTimeout(r, 5000));
		}
		description = healthy ? 'Temp deploy is ready' : 'Temp deploy will be ready in a few seconds';
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

async function cleanupDeployments(githubApi: GitHubApi, args: DeploymentArgs): Promise<void> {
	const environment = requireArg(args, 'environment');
	const res = await githubApi(`/deployments?environment=${encodeURIComponent(environment)}&per_page=100`);
	const deployments = (await res.json()) as GitHubDeployment[];

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

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { values } = parseArgs({
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
		},
	});
	const args = values as DeploymentArgs;
	const action = requireArg(args, 'action');
	const githubApi = createGitHubApi(requireArg(args, 'token'), requireArg(args, 'repo'));
	requireArg(args, 'environment');

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

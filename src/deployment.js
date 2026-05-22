import fs from 'node:fs';
import { parseArgs, createGitHubApi } from './utils.js';

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

async function markDeploymentSuccess(githubApi, args) {
	const environment = args['environment'];
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
	const args = parseArgs(argv, { required: ['token', 'repo', 'action', 'environment'] });
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

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});

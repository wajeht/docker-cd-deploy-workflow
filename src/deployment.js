import { parseArgs, createGitHubApi } from './utils.js';

const args = parseArgs(process.argv.slice(2), { required: ['token', 'repo', 'action', 'environment'] });

const action = args['action'];
const environment = args['environment'];
const url = args['url'];
const ref = args['ref'] || 'main';

const githubApi = createGitHubApi(args['token'], args['repo']);

try {
	if (action === 'request') {
		const res = await githubApi('/deployments', {
			method: 'POST',
			body: JSON.stringify({
				ref,
				environment,
				auto_merge: false,
				required_contexts: [],
				transient_environment: true,
				production_environment: false,
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
			const fs = await import('node:fs');
			fs.appendFileSync(outputFile, `deployment-id=${deployment.id}\n`);
		}
	} else if (action === 'deploy') {
		const deploymentId = args['deployment-id'];
		if (!url || !deploymentId) {
			console.error('--url and --deployment-id are required for deploy action');
			process.exit(1);
		}

		// Poll URL for up to 60s before marking success
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
				console.log(`Attempt ${i}/12: not reachable`);
			}
			if (i < 24) await new Promise((r) => setTimeout(r, 5000));
		}

		const description = healthy ? 'Temp deploy is ready' : 'Temp deploy will be ready in a few seconds';
		console.log(description);

		await githubApi(`/deployments/${deploymentId}/statuses`, {
			method: 'POST',
			body: JSON.stringify({
				state: 'success',
				environment_url: url,
				description,
			}),
		});

		console.log(`Deployment ${deploymentId} for ${environment} -> ${url}`);
	} else if (action === 'cleanup') {
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
	} else {
		console.error(`Unknown action: ${action}`);
		process.exit(1);
	}
} catch (err) {
	console.error(err.message);
	process.exit(1);
}

import { parseArgs, createGitHubApi } from './utils.js';

const args = parseArgs(process.argv.slice(2), { required: ['token', 'repo', 'action', 'environment'] });

const action = args['action'];
const environment = args['environment'];
const url = args['url'];
const ref = args['ref'] || 'main';

const githubApi = createGitHubApi(args['token'], args['repo']);

try {
	if (action === 'deploy') {
		if (!url) {
			console.error('--url is required for deploy action');
			process.exit(1);
		}

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
				state: 'success',
				environment_url: url,
				description: 'Temp deploy is ready',
			}),
		});

		console.log(`Created deployment ${deployment.id} for ${environment} -> ${url}`);
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

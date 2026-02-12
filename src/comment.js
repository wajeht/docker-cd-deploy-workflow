import { parseArgs, createGitHubApi } from './utils.js';

const args = parseArgs(process.argv.slice(2), { required: ['token', 'repo', 'pr-number', 'action'] });

const prNumber = args['pr-number'];
const action = args['action'];
const url = args['url'];
const tag = args['tag'];

const githubApi = createGitHubApi(args['token'], args['repo']);

const marker = '<!-- temp-deploy -->';
const date = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

let body;
if (action === 'deploy') {
	if (!url || !tag) {
		console.error('--url and --tag are required for deploy action');
		process.exit(1);
	}
	body = `${marker}\n🚀 **Temp deploy ready**\n\n${url}\n\nTag: \`${tag}\` | Updated: ${date}\n\n_docker-cd will pick this up within ~60s_`;
} else if (action === 'cleanup') {
	body = `${marker}\n**Temp deploy removed**\n\nCleaned up: ${date}`;
} else {
	console.error(`Unknown action: ${action}`);
	process.exit(1);
}

try {
	// Find existing comment
	const res = await githubApi(`/issues/${prNumber}/comments`);
	const comments = await res.json();
	const existing = comments.find((c) => c.body.includes(marker));

	if (existing) {
		await githubApi(`/issues/comments/${existing.id}`, {
			method: 'PATCH',
			body: JSON.stringify({ body }),
		});
		console.log(`Updated comment ${existing.id}`);
	} else if (action === 'deploy') {
		await githubApi(`/issues/${prNumber}/comments`, {
			method: 'POST',
			body: JSON.stringify({ body }),
		});
		console.log('Created deploy comment');
	} else {
		console.log('No existing temp-deploy comment found, nothing to update');
	}
} catch (err) {
	console.error(err.message);
	process.exit(1);
}

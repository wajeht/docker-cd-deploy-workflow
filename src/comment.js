import { parseArgs } from './utils.js';

const args = parseArgs(process.argv.slice(2));

const required = ['token', 'repo', 'pr-number', 'action'];
for (const key of required) {
	if (!args[key]) {
		console.error(`Missing required arg: --${key}`);
		process.exit(1);
	}
}

const token = args['token'];
const repo = args['repo'];
const prNumber = args['pr-number'];
const action = args['action'];
const url = args['url'];
const tag = args['tag'];

const marker = '<!-- temp-deploy -->';
const apiBase = `https://api.github.com/repos/${repo}`;
const headers = {
	Authorization: `Bearer ${token}`,
	Accept: 'application/vnd.github+json',
	'Content-Type': 'application/json',
	'X-GitHub-Api-Version': '2022-11-28',
};

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

// Find existing comment
const res = await fetch(`${apiBase}/issues/${prNumber}/comments`, { headers });
if (!res.ok) {
	console.error(`Failed to list comments: ${res.status} ${await res.text()}`);
	process.exit(1);
}

const comments = await res.json();
const existing = comments.find((c) => c.body.includes(marker));

if (existing) {
	const updateRes = await fetch(`${apiBase}/issues/comments/${existing.id}`, {
		method: 'PATCH',
		headers,
		body: JSON.stringify({ body }),
	});
	if (!updateRes.ok) {
		console.error(`Failed to update comment: ${updateRes.status} ${await updateRes.text()}`);
		process.exit(1);
	}
	console.log(`Updated comment ${existing.id}`);
} else if (action === 'deploy') {
	const createRes = await fetch(`${apiBase}/issues/${prNumber}/comments`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ body }),
	});
	if (!createRes.ok) {
		console.error(`Failed to create comment: ${createRes.status} ${await createRes.text()}`);
		process.exit(1);
	}
	console.log('Created deploy comment');
} else {
	console.log('No existing temp-deploy comment found, nothing to update');
}

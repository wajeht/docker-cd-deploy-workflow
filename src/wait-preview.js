import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { authPath, authEnvironment, previewId } from './preview-access.js';

export function validateApiConfig(env = process.env) {
	let url;
	try { url = new URL(env.DOCKER_CD_URL); } catch { /* validated below */ }
	if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !env.DOCKER_CD_API_SECRET) {
		throw new Error('Tinyauth previews require HTTPS DOCKER_CD_URL and DOCKER_CD_API_SECRET secrets');
	}
	return { url: url.href.replace(/\/$/, ''), secret: env.DOCKER_CD_API_SECRET };
}

function git(args) {
	return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A later deployment is acceptable only if it still contains this operation.
// Compare our own ACL, allowing other previews to be added/removed concurrently.
export function deployedRevisionMatches(expected, actual, { appPath, prNumber, auth = false }) {
	if (!/^[a-f0-9]{40}$/.test(actual || '')) return false;
	try {
		git(['cat-file', '-e', actual]);
	} catch {
		git(['fetch', 'origin', 'main']);
	}
	try {
		git(['merge-base', '--is-ancestor', expected, actual]);
		if (!auth) return git(['diff', '--name-only', expected, actual, '--', `${appPath}-pr-${prNumber}`]) === '';
		const projection = (ref) => {
			const env = authEnvironment(git(['show', `${ref}:${authPath}`]) + '\n');
			const prefix = `TINYAUTH_APPS_${previewId(appPath, prNumber)}_`;
			return Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith(prefix) || !key.startsWith('TINYAUTH_APPS_')));
		};
		return isDeepStrictEqual(projection(expected), projection(actual));
	} catch { return false; }
}

export function projectReady(data, matches, auth = false) {
	return data?.sync === 'synced' && data.lastDeploy?.status === 'synced' &&
		matches(data.lastDeploy.commitSHA) && data.health?.total > 0 &&
		data.health.running === data.health.total && data.health.unhealthy === 0 &&
		(!auth || data.health.healthy === data.health.total) &&
		Array.isArray(data.containers) && data.containers.length > 0 &&
		data.containers.every((container) => container.State === 'running' && (!container.Health || container.Health === 'healthy'));
}

export async function waitForPreview({ appPath, prNumber, commit, cleanup = false, fetchFn = fetch,
	matches = deployedRevisionMatches, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 60 }) {
	const { url, secret } = validateApiConfig();
	const deadline = Date.now() + 600000;
	async function project(name) {
		const response = await fetchFn(`${url}/api/projects/${encodeURIComponent(name)}`, {
			headers: { Authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
		});
		if (response.status === 401 || response.status === 403) throw new Error('docker-cd API authentication failed');
		if (response.status === 404) return null;
		if (!response.ok) return undefined;
		const body = await response.json();
		return body.success === true ? body.data : undefined;
	}
	for (let i = 0; i < attempts && Date.now() < deadline; i++) {
		let auth, preview;
		try {
			auth = await project('tinyauth');
			preview = await project(`${path.basename(appPath)}-pr-${prNumber}`);
		} catch (err) {
			if (err.message === 'docker-cd API authentication failed') throw err;
			// Transient network errors must never be mistaken for removal or readiness.
		}
		const match = (auth) => (actual) => matches(commit, actual, { appPath, prNumber, auth });
		if (projectReady(auth, match(true), true) && (cleanup ? preview === null : projectReady(preview, match(false)))) return;
		if (i + 1 < attempts) await sleep(Math.max(0, Math.min(10000, deadline - Date.now())));
	}
	throw new Error('Timed out waiting for docker-cd to apply the preview and Tinyauth configuration');
}

export async function main(argv = process.argv.slice(2)) {
	const { values: args } = parseArgs({ args: argv, options: {
		'app-path': { type: 'string' }, 'pr-number': { type: 'string' }, commit: { type: 'string' }, cleanup: { type: 'boolean' },
	} });
	if (!/^[a-f0-9]{40}$/.test(args.commit || '')) throw new Error('A committed preview revision is required');
	await waitForPreview({ appPath: args['app-path'], prNumber: args['pr-number'], commit: args.commit, cleanup: args.cleanup });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main().catch((err) => { console.error(err.message); process.exit(1); });
}

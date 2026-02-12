export function parseArgs(argv, { required = [] } = {}) {
	const result = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith('--')) {
			const key = argv[i].slice(2);
			const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
			result[key] = val;
		}
	}
	for (const key of required) {
		if (!result[key]) {
			console.error(`Missing required arg: --${key}`);
			process.exit(1);
		}
	}
	return result;
}

export function createGitHubApi(token, repo) {
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

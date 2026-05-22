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
			throw new Error(`Missing required arg: --${key}`);
		}
	}
	return result;
}

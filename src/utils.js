export function parseArgs(argv) {
	const result = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith('--')) {
			const key = argv[i].slice(2);
			const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
			result[key] = val;
		}
	}
	return result;
}

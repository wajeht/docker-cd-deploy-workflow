import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseArgs } from './utils.js';

describe('parseArgs', () => {
	it('parses flags and values', () => {
		assert.deepStrictEqual(parseArgs(['--app-path', 'apps/demo', '--all']), {
			'app-path': 'apps/demo',
			all: true,
		});
	});

	it('throws when required args are missing', () => {
		assert.throws(() => parseArgs([], { required: ['app-path'] }), /Missing required arg: --app-path/);
	});
});

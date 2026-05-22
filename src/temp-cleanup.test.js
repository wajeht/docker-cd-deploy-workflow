import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from './temp-cleanup.js';

describe('temp-cleanup', () => {
	it('removes the matching temp stack', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-cd-deploy-workflow-'));
		const appPath = path.join(dir, 'apps', 'demo');
		const tempPath = `${appPath}-pr-42`;

		try {
			fs.mkdirSync(tempPath, { recursive: true });
			fs.writeFileSync(path.join(tempPath, 'docker-compose.yml'), 'services: {}\n');

			await main(['--app-path', appPath, '--pr-number', '42']);

			assert.strictEqual(fs.existsSync(tempPath), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('does nothing when the temp stack is already gone', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-cd-deploy-workflow-'));
		const appPath = path.join(dir, 'apps', 'demo');

		try {
			await main(['--app-path', appPath, '--pr-number', '42']);

			assert.strictEqual(fs.existsSync(`${appPath}-pr-42`), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

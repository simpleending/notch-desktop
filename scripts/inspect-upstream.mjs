import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { inspectInstallation } from '../src/upstream-inspection.mjs';
const { values } = parseArgs({ options: { installation: { type: 'string' }, out: { type: 'string' } } });
if (!values.installation) throw new Error('Use --installation /path/to/installed/app [--out report.json].');
const report = JSON.stringify(await inspectInstallation(values.installation), null, 2) + '\n';
if (values.out) await writeFile(values.out, report, { flag: 'wx' });
else console.log(report);

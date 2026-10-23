import {runLocalModelsCli} from './commands/local-models.js';

// Desktop mounting owns the inference lease and checks current memory separately.
const result = await runLocalModelsCli(process.argv.slice(2), {downloadOnly: true});
process.exitCode = result.code;

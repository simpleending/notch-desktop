import { localModels } from '../src/cli-bridge.mjs';
const catalog = await localModels();
console.log(JSON.stringify(catalog, null, 2));

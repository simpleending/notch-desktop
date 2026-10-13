export {
  resolveModel,
  validateConfig,
  MODEL_CATALOG,
  MODEL_IDS,
  isValidModel,
  modelSupportsImages,
  MissingApiKeyError,
  // BYOK re-exports
  findByokProvider,
  listByokProviders,
  isByokRef,
  parseByokRef,
  resolveByokModel,
  validateByokConfig,
  ByokMissingApiKeyError,
  ByokMissingBaseUrlError,
  BUILTIN_BYOK_PROVIDERS,
} from './registry.js';
export type { ModelConfig, ModelRoles, NotchModelId, NotchModelInfo } from './types.js';
export type { ByokProvider, ByokSpec, ApiShape } from './byok.js';

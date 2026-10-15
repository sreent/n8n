/** Must match the backend module id. */
export const AI_GATEWAY_MODULE_ID = 'ai-gateway';

/** The id of the store. The store of the editor shell for Gateway credits uses `aiGateway`. */
export const AI_GATEWAY_ADMIN_STORE = 'forkAiGatewayAdmin';

/** Route name of the settings page. */
export const AI_GATEWAY_ADMIN_VIEW = 'SettingsForkAiGatewayView';

/** The global scope that the REST API of the page needs ("Manage AI usage"). */
export const AI_GATEWAY_SCOPE = 'aiAssistant:manage';

/** The backend gives at most 250 calls for each page. */
export const USAGE_PAGE_SIZES = [25, 50, 100, 250];

export const DEFAULT_USAGE_PAGE_SIZE = 50;

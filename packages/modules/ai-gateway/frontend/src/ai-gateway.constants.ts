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

/** The page sizes of the tables that get all their rows at once. */
export const TABLE_PAGE_SIZES = [25, 50, 100];

export const DEFAULT_TABLE_PAGE_SIZE = 25;

/**
 * The provider whose models cost nothing without a price. The backend marks it `freeByDefault`,
 * but it does not send that flag to the page.
 */
export const FREE_BY_DEFAULT_PROVIDER = 'ollama';

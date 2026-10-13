import type { UsageState } from '@n8n/api-types';

import type { IRestApiContext } from '../types';
import { makeRestApiRequest } from '../utils';

// Fork: the client reads the licence data only. The fork has no routes that register the Community
// Edition, request a trial, or activate or renew a licence key (packages/cli/src/license/FORK.md).
export const getLicense = async (context: IRestApiContext): Promise<UsageState['data']> => {
	return await makeRestApiRequest(context, 'GET', '/license');
};

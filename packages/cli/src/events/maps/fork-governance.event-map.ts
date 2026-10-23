import type { JsonValue } from 'n8n-workflow';

import type { UserLike } from '@/types/user-like.types';

/** What changed in a Git connection, for `git-connection-updated`. */
export type GitConnectionChange =
	| 'settings'
	| 'configuration'
	| 'configuration-removed'
	| 'project-linked'
	| 'project-unlinked'
	| 'cloned'
	| 'checkout-removed';

type DestinationEvent = {
	user: UserLike;
	destinationId: string;
	destinationType: string;
	label: string;
	enabled: boolean;
};

/**
 * Fork code (not in upstream n8n): the governance actions of the fork features. The relay
 * `ForkGovernanceEventRelay` sends each event to log streaming and the audit log as an
 * `n8n.audit.*` event. No payload holds a token, a password or a key.
 */
export type ForkGovernanceEventMap = {
	// #region Git sync

	'git-sync-settings-saved': {
		user: UserLike;
		projectId: string;
		repositoryUrl: string;
		branch: string;
		directory: string;
		isNew: boolean;
		tokenChanged: boolean;
	};

	'git-sync-disconnected': {
		user: UserLike;
		projectId: string | null;
		repositoryUrl: string | null;
	};

	'git-sync-pushed': {
		user: UserLike;
		projectId: string;
		repositoryUrl: string;
		branch: string;
		commit: string;
		changedFiles: number;
		replacedRemoteContent: boolean;
	};

	'git-sync-pulled': {
		user: UserLike;
		projectId: string;
		repositoryUrl: string;
		branch: string;
		commit: string;
		created: number;
		updated: number;
		skipped: number;
		overwroteLocalChanges: boolean;
	};

	// #endregion

	// #region AI gateway

	'ai-gateway-settings-updated': {
		user: UserLike;
		enabled: boolean;
		/** The top-level settings that changed, for example `enabled` or `projectBudgets`. */
		changed: string[];
		/** The slugs of the providers that have a credential. */
		providers: string[];
		monthlyBudget: number;
		userMonthlyLimit: number | null;
	};

	'ai-gateway-top-up-added': {
		user: UserLike;
		amount: number;
		note: string | null;
	};

	// #endregion

	// #region Log streaming

	'log-streaming-destination-created': DestinationEvent;

	'log-streaming-destination-updated': DestinationEvent;

	'log-streaming-destination-deleted': DestinationEvent;

	// #endregion

	// #region Git connections

	'git-connection-provider-created': {
		user: UserLike;
		providerId: string;
		providerName: string;
		authType: string;
	};

	'git-connection-provider-updated': {
		user: UserLike;
		providerId: string;
		providerName: string;
		credentialsReplaced: boolean;
	};

	'git-connection-provider-deleted': {
		user: UserLike;
		providerId: string;
		providerName: string;
	};

	'git-connection-created': {
		user: UserLike;
		connectionId: string;
		connectionName: string;
		scope: string;
		remoteUrl: string;
	};

	'git-connection-updated': {
		user: UserLike;
		connectionId: string;
		connectionName: string;
		change: GitConnectionChange;
		direction?: 'apply' | 'promote';
		projectId?: string;
	};

	'git-connection-deleted': {
		user: UserLike;
		connectionId: string;
		connectionName: string;
	};

	'git-connection-promoted': {
		user: UserLike;
		connectionId: string;
		/** The team project of a promotion of chosen workflows. */
		projectId?: string;
		branchName: string;
		commitSha: string;
		counts: JsonValue;
	};

	'git-connection-applied': {
		user: UserLike;
		connectionId: string;
		branchName: string;
		commitSha: string;
		counts: JsonValue;
	};

	// #endregion
};

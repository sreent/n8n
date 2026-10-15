import { Container } from '@n8n/di';
import isEqual from 'lodash/isEqual';
import type {
	ICredentialDataDecryptedObject,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';
import { NodeHelpers } from 'n8n-workflow';

import { CredentialTypes } from '@/credential-types';

/**
 * The properties of a credential type, with the properties of the types that it extends. A
 * property of the type replaces the inherited one. The merge leaves out each property with
 * `doNotInherit`, also of the type itself: such a property is a setting of the credential, not
 * of the app that the users share.
 */
function credentialTypeProperties(type: ICredentialType): INodeProperties[] {
	const merged: INodeProperties[] = [];
	for (const parentName of type.extends ?? []) {
		const parent = Container.get(CredentialTypes).getByName(parentName);
		NodeHelpers.mergeNodeProperties(merged, credentialTypeProperties(parent));
	}
	NodeHelpers.mergeNodeProperties(merged, type.properties);
	return merged;
}

/**
 * The fields of a credential type that all users of a private credential share: each declared
 * field that is not a `resolvableField`. Each user stores the other fields (for example the
 * OAuth token) in their own entry.
 */
export function extractSharedFields(type: ICredentialType): string[] {
	const names: string[] = [];
	for (const property of credentialTypeProperties(type)) {
		if (property.resolvableField === true || names.includes(property.name)) continue;
		names.push(property.name);
	}
	return names;
}

/**
 * The shared fields that the new data sets to another value. A field that the new data does not
 * contain did not change.
 */
export function getChangedSharedFields(
	type: ICredentialType,
	oldData: ICredentialDataDecryptedObject,
	newData: ICredentialDataDecryptedObject,
): string[] {
	return extractSharedFields(type).filter(
		(field) => Object.hasOwn(newData, field) && !isEqual(oldData[field], newData[field]),
	);
}

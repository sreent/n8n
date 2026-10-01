import { GLOBAL_CHAT_USER_ROLE, GLOBAL_OWNER_ROLE, User } from '@n8n/db';
import { Service } from '@n8n/di';
import { Brackets, DataSource, In, Repository } from '@n8n/typeorm';

/** Reads the users who can receive a copy of a workflow. */
@Service()
export class SendCopyRecipientRepository extends Repository<User> {
	constructor(dataSource: DataSource) {
		super(User, dataSource.manager);
	}

	/**
	 * Finds active users who can receive a copy from `senderId`, ordered by name.
	 *
	 * Excludes the sender, disabled users, chat users, and pending users. A user is
	 * pending when the user has no password, no external sign-in identity, and is not
	 * the owner. This is the same rule as `User.computeIsPending`.
	 */
	async findCandidates(
		senderId: string,
		options: { search?: string; limit: number },
	): Promise<User[]> {
		const query = this.createQueryBuilder('user')
			.innerJoinAndSelect('user.role', 'role')
			.leftJoin('user.authIdentities', 'identity', 'identity.providerType != :emailProvider', {
				emailProvider: 'email',
			})
			.where('user.disabled = :disabled', { disabled: false })
			.andWhere('user.id != :senderId', { senderId })
			.andWhere('role.slug != :chatUserRole', { chatUserRole: GLOBAL_CHAT_USER_ROLE.slug })
			.andWhere(
				new Brackets((qb) => {
					qb.where('user.password IS NOT NULL')
						.orWhere('role.slug = :ownerRole', { ownerRole: GLOBAL_OWNER_ROLE.slug })
						.orWhere('identity.userId IS NOT NULL');
				}),
			);

		if (options.search) {
			const pattern = `%${options.search}%`;
			query.andWhere(
				new Brackets((qb) => {
					qb.where('LOWER(user.firstName) LIKE LOWER(:pattern)', { pattern })
						.orWhere('LOWER(user.lastName) LIKE LOWER(:pattern)', { pattern })
						.orWhere('LOWER(user.email) LIKE LOWER(:pattern)', { pattern });
				}),
			);
		}

		return await query
			.orderBy('user.firstName', 'ASC')
			.addOrderBy('user.lastName', 'ASC')
			.addOrderBy('user.email', 'ASC')
			.take(options.limit)
			.getMany();
	}

	/** Finds users by ID with the relations that `User.isPending` needs. */
	async findByIdsForCopy(ids: string[]): Promise<User[]> {
		if (ids.length === 0) return [];
		return await this.find({
			where: { id: In(ids) },
			relations: { role: true, authIdentities: true },
		});
	}
}

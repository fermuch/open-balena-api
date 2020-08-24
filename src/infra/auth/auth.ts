import type { Request } from 'express';
import * as _ from 'lodash';

import { sbvrUtils, hooks, permissions, errors } from '@balena/pinejs';

import { retrieveAPIKey } from './api-keys';
import { User } from './jwt-passport';

import { getIP } from '../../lib/utils';
import type { User as DbUser } from '../../models';

const {
	BadRequestError,
	ConflictError,
	UnauthorizedError,
	NotFoundError,
} = errors;
const { api } = sbvrUtils;

const USERNAME_BLACKLIST = ['root'];

export const userHasPermission = (
	user: undefined | sbvrUtils.User,
	permission: string,
): boolean => {
	if (user == null || user.permissions == null) {
		return false;
	}
	return user.permissions.includes(permission);
};

/**
 * A known invalid comparisson to emulate a wrong password error.
 * Used to prevent exposing information via timing attacks.
 */
const runInvalidPasswordComparison = () =>
	sbvrUtils.sbvrTypes.Hashed.compare(
		'',
		'$2b$10$Wj6ud7bYmcAw4B1uuORsnuYODUKSkrH6dVwG1zoUhDeTCjwsxlp5.',
	);

export const comparePassword = (password: string, hash: string | null) =>
	hash == null
		? runInvalidPasswordComparison()
		: sbvrUtils.sbvrTypes.Hashed.compare(password, hash);

export const validatePassword = (password?: string) => {
	if (!password) {
		throw new BadRequestError('Password required.');
	}
	if (password.length < 8) {
		throw new BadRequestError('Password must be at least 8 characters.');
	}
};

// Think twice before using this function as it *unconditionally* sets the
// password for the given user to the given string. Changing a user password
// will also generate a new token secret, effectively invalidating all current
// login sessions.
export const setPassword = async (
	user: AnyObject,
	newPassword: string,
	tx?: Tx,
) => {
	await api.resin.patch({
		resource: 'user',
		id: user.id,
		passthrough: {
			req: permissions.root,
			tx,
		},
		body: {
			password: newPassword,
		},
	});
};

// Conditionally updates the password for the given user if it differs from
// the one currently stored, using `setPassword()` which means that function's
// caveats apply here as well.
export const updatePasswordIfNeeded = async (
	usernameOrEmail: string,
	newPassword: string,
	tx?: Tx,
): Promise<boolean> => {
	const user = await findUser(usernameOrEmail, tx);
	if (user == null) {
		throw new NotFoundError('User not found.');
	}

	const match = await comparePassword(newPassword, user.password);
	if (match) {
		return false;
	}
	try {
		await setPassword(user, newPassword, tx);
		return true;
	} catch {
		return false;
	}
};

export const checkUserPassword = async (
	password: string,
	userId: number,
): Promise<void> => {
	const user = (await api.resin.get({
		resource: 'user',
		id: userId,
		passthrough: {
			req: permissions.root,
		},
		options: {
			$select: ['password', 'id'],
		},
	})) as Pick<DbUser, 'password' | 'id'>;
	if (user == null) {
		throw new BadRequestError('User not found.');
	}

	const passwordIsOk = await comparePassword(password, user.password);
	if (!passwordIsOk) {
		throw new BadRequestError('Current password incorrect.');
	}
};

export const reqHasPermission = (req: Request, permission: string): boolean =>
	userHasPermission(req.apiKey || req.user, permission);

// If adding/removing fields, please also update `User`
// in "typings/common.d.ts".
export const userFields = [
	'id',
	'username',
	'email',
	'created_at',
	'jwt_secret',
];

const getUserQuery = _.once(() =>
	api.resin.prepare<{ key: string }>({
		resource: 'user',
		passthrough: { req: permissions.root },
		options: {
			$select: userFields,
			$filter: {
				actor: {
					$any: {
						$alias: 'a',
						$expr: {
							a: {
								api_key: {
									$any: {
										$alias: 'k',
										$expr: {
											k: { key: { '@': 'key' } },
										},
									},
								},
							},
						},
					},
				},
			},
			$top: 1,
		},
	}),
);
export function getUser(
	req: Request | hooks.HookReq,
	required?: true,
): Promise<User>;
export function getUser(
	req: Request | hooks.HookReq,
	required: false,
): Promise<User | undefined>;
export async function getUser(
	req: hooks.HookReq & {
		user?: User;
		creds?: User;
	},
	required = true,
): Promise<User | undefined> {
	await retrieveAPIKey(req);
	// This shouldn't happen but it does for some internal PineJS requests
	if (req.user && !req.creds) {
		req.creds = req.user;
	}

	// JWT or API key already loaded
	if (req.creds) {
		if (required && !req.user) {
			throw new UnauthorizedError('User has not been authorized');
		}
		// If partial user, promise will resolve to `null` user
		return req.user;
	}

	let key;
	if (req.apiKey != null) {
		key = req.apiKey.key;
	}
	if (!key) {
		if (required) {
			throw new UnauthorizedError('Request has no JWT or API key');
		}
		return;
	}

	const [user] = await getUserQuery()({ key });
	if (user) {
		// Store it in `req` to be compatible with JWTs and for caching
		req.user = req.creds = _.pick(user, userFields) as User;
	} else if (required) {
		throw new UnauthorizedError('User not found for API key');
	}
	return req.user;
}

export const defaultFindUser$select = [
	'id',
	'actor',
	'username',
	'password',
] as const;

export async function findUser(
	loginInfo: string,
	tx?: Tx,
): Promise<Pick<DbUser, typeof defaultFindUser$select[number]> | undefined>;
export async function findUser<
	T extends DbUser,
	TProps extends ReadonlyArray<keyof T>
>(
	loginInfo: string,
	tx: Tx | undefined,
	$select: TProps,
): Promise<Pick<T, typeof $select[number]> | undefined>;
export async function findUser<
	T extends DbUser,
	TProps extends ReadonlyArray<keyof T & string>
>(
	loginInfo: string,
	tx?: Tx,
	$select: TProps = (defaultFindUser$select as ReadonlyArray<
		keyof DbUser & string
	>) as TProps,
) {
	if (!loginInfo) {
		return;
	}

	let loginField;
	if (loginInfo.includes('@')) {
		loginField = 'email';
	} else {
		loginField = 'username';
	}

	type UserResult = Pick<T, typeof $select[number]>;
	const [user] = (await api.resin.get({
		resource: 'user',
		passthrough: {
			req: permissions.root,
			tx,
		},
		options: {
			$filter: {
				$eq: [
					{
						$tolower: { $: loginField },
					},
					{
						$tolower: loginInfo,
					},
				],
			},
			$select: $select as Writable<typeof $select>,
		},
	})) as [UserResult?];
	return user;
}

export const registerUser = async (
	userData: AnyObject & {
		username: string;
		email: string;
		password?: string;
	},
	tx: Tx,
	req?: Request,
): Promise<AnyObject> => {
	if (USERNAME_BLACKLIST.includes(userData.username)) {
		throw new ConflictError('This username is blacklisted');
	}
	let existingUser = await findUser(userData.email, tx, ['id']);
	if (existingUser) {
		throw new ConflictError('This email is already taken');
	}

	existingUser = await findUser(userData.username, tx, ['id']);
	if (existingUser) {
		throw new ConflictError('This username is already taken');
	}

	let clientIP;
	if (req) {
		clientIP = getIP(req);
	}

	// Create the user in the platform
	const user = await api.resin.post({
		resource: 'user',
		body: {
			...userData,
		},
		passthrough: {
			tx,
			req: permissions.root,
			custom: {
				clientIP,
			},
		},
	});

	if (user.id == null) {
		throw new Error('Error creating user in the platform');
	}
	return user;
};

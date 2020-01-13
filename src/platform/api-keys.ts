import * as randomstring from 'randomstring';
import * as _ from 'lodash';
import { isJWT } from './jwt';
import { sbvrUtils } from '@resin/pinejs';
import { Tx } from './index';
import { Request } from 'express';

const { root, api } = sbvrUtils;

interface ApiKeyOptions {
	apiKey?: string;
	name?: string;
	description?: string;
	tx?: Tx;
}

interface InternalApiKeyOptions extends ApiKeyOptions {
	apiKey: string;
	tx: Tx;
}

const $createApiKey = async (
	actorType: string,
	roleName: string,
	req: Request,
	actorTypeID: number,
	{ apiKey, tx, name, description }: InternalApiKeyOptions,
): Promise<string> => {
	const actorable = (await api.resin.get({
		resource: actorType,
		id: actorTypeID,
		passthrough: { req, tx },
		options: {
			$select: 'actor',
		},
	})) as AnyObject;

	const actorID: number | undefined = actorable?.actor;
	if (actorID == null) {
		throw new Error(`No ${actorType} found to associate with the api key`);
	}

	const res = await api.resin.post({
		url: `${actorType}(${actorTypeID})/canAccess`,
		passthrough: { req, tx },
		body: {
			action: `create-${roleName}`,
		},
	});

	const resId: number | undefined = _.get(res, ['d', 0, 'id']);
	if (resId !== actorTypeID) {
		throw new sbvrUtils.ForbiddenError();
	}

	const authApiTx = api.Auth.clone({
		passthrough: {
			tx,
			req: root,
		},
	});

	const [{ id: apiKeyId }, [{ id: roleId }]] = await Promise.all([
		authApiTx.post({
			resource: 'api_key',
			body: {
				is_of__actor: actorID,
				key: apiKey,
				name,
				description,
			},
			options: { returnResource: false },
		}) as Promise<{ id: number }>,
		authApiTx.get({
			resource: 'role',
			options: {
				$select: 'id',
				$filter: {
					name: roleName,
				},
			},
		}) as Promise<Array<{ id: number }>>,
	]);

	await authApiTx.post({
		resource: 'api_key__has__role',
		body: {
			api_key: apiKeyId,
			role: roleId,
		},
		options: { returnResource: false },
	});

	return apiKey;
};

export const createApiKey = (
	actorType: string,
	roleName: string,
	req: Request,
	actorTypeID: number,
	options: ApiKeyOptions = {},
): Promise<string> => {
	if (options.apiKey == null) {
		options.apiKey = randomstring.generate();
	}
	if (options.tx != null) {
		return $createApiKey(
			actorType,
			roleName,
			req,
			actorTypeID,
			options as InternalApiKeyOptions,
		);
	} else {
		return sbvrUtils.db.transaction(tx => {
			options.tx = tx;
			return $createApiKey(
				actorType,
				roleName,
				req,
				actorTypeID,
				options as InternalApiKeyOptions,
			);
		});
	}
};

export interface PartialCreateKey {
	(req: Request, actorTypeID: number, options?: ApiKeyOptions): Promise<string>;
}

const isRequest = (req: sbvrUtils.HookReq | Request): req is Request =>
	'get' in req;

export const retrieveAPIKey = (
	req: sbvrUtils.HookReq | Request,
): Promise<void> =>
	// We should be able to skip this if req.user but doing so breaks the SDK
	// because it sends both a JWT and an API Key in requests like /devices/register
	sbvrUtils.apiKeyMiddleware(req).then(() => {
		// Skip for Pine's request objects that don't support headers
		if (!isRequest(req)) {
			return;
		}

		// While this could be omitted, Pine will go to the DB in vain if not handled
		const token = (req.get('Authorization') || '').split(' ')[1];
		if (token && !isJWT(token)) {
			// Add support for API keys on Authorization header if a JWT wasn't provided
			return sbvrUtils.authorizationMiddleware(req);
		}
	});

import jose from 'node-jose';
import { DocumentInstance, DocumentListInstance } from 'twilio/lib/rest/sync/v1/service/document';
const fetch = require('node-fetch');

type CAToken = {
  access_token: string;
  token_type: string;
  expires_in: number;
  key_id: string;
}

// Helper method to simplify getting a Sync resource (Document, List, or Map)
// that handles the case where it may not exist yet.
const getOrCreateResource: (resource: DocumentListInstance, name: string, options?: { uniqueName?: string }) => Promise<DocumentInstance> = async (resource, name, options = {}) => {
  try {
    // Does this resource (Sync Document, List, or Map) exist already? Return it
    return await resource(name).fetch();
  } catch (err) {
    // It doesn't exist, create a new one with the given name and return it
    options.uniqueName = name;
    return await resource.create(options);
  }
};

export const getLineChannelAccessToken: ({ syncServiceSid, assertionSigningKey, channelId }: { syncServiceSid: string, assertionSigningKey: string, channelId: string }) => Promise<CAToken> = async ({ syncServiceSid, assertionSigningKey, channelId }) => {

  const privateKey = Runtime.getAssets()['/private_key.key'].open();

  const syncClient = Runtime.getSync({ serviceName: syncServiceSid });

  const document = await getOrCreateResource(syncClient.documents, 'line-channel-access-token');

  let CAToken: CAToken = document.data;

  if (CAToken.access_token === undefined) {

    const header = {
      alg: "RS256",
      typ: "JWT",
      kid: assertionSigningKey
    };

    const payload = {
      iss: channelId,
      sub: channelId,
      aud: "https://api.line.me/",
      exp: Math.floor(new Date().getTime() / 1000) + 60 * 30,
      token_exp: 60 * 60 * 24 * 30
    };

    const JWToken = await jose.JWS.createSign({ format: 'compact', fields: header }, JSON.parse(privateKey))
      .update(JSON.stringify(payload))
      .final();

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    params.append('client_assertion', JWToken.toString());

    const request = await fetch(`https://api.line.me/oauth2/v2.1/token`, {
      method: "POST",
      body: params
    });

    if (!request.ok) {
      throw new Error('Error while retrieving channel access token from Line');
    }

    CAToken = request.json() as unknown as CAToken;

    await document.update({ data: CAToken, ttl: 60 * 60 * 24 * 29 });

  }

  return CAToken;

}
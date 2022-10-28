import { Client as LineClient } from '@line/bot-sdk';
import '@twilio-labs/serverless-runtime-types';
import { Context, ServerlessCallback, ServerlessFunctionSignature } from '@twilio-labs/serverless-runtime-types/types';
import jose from 'node-jose';
import { DocumentInstance, DocumentListInstance } from 'twilio/lib/rest/sync/v1/service/document';
const fetch = require('node-fetch');

type MyEvent = {
  Source: string;
  ConversationSid: string;
  Body: string;
  Media?: string;
}

type MyContext = {
  ACCOUNT_SID: string;
  AUTH_TOKEN: string;
  FLEX_CONVERSATION_SERVICE_SID: string;
  LINE_CHANNEL_ID: string;
  LINE_CHANNEL_SECRET: string;
  LINE_ASSERTION_SIGNING_KEY: string;
  TWILIO_SYNC_SERVICE_SID: string;
}

type CAToken = {
  access_token: string;
  token_type: string;
  expires_in: number;
  key_id: string;
}

// Helper method to simplify getting a Sync resource (Document, List, or Map)
// that handles the case where it may not exist yet.
const getOrCreateResource: (resource: DocumentListInstance, name: string, options?: object) => Promise<DocumentInstance> = async (resource, name, options = {}) => {
  try {
    // Does this resource (Sync Document, List, or Map) exist already? Return it
    return await resource(name).fetch();
  } catch (err) {
    // It doesn't exist, create a new one with the given name and return it
    // @ts-ignore
    options.uniqueName = name;
    return await resource.create(options);
  }
};

const getLineChannelAccessToken: ({ syncServiceSid, privateKey, assertionSigningKey, channelId }: { syncServiceSid: string, privateKey: string, assertionSigningKey: string, channelId: string }) => Promise<CAToken> = async ({ syncServiceSid, privateKey, assertionSigningKey, channelId }) => {

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

    CAToken = request.json() as CAToken;

    await document.update({ data: CAToken, ttl: 60 * 60 * 24 * 29 });

  }

  return CAToken;

}

export const handler: ServerlessFunctionSignature<MyContext, MyEvent> = async function (
  context: Context<MyContext>,
  event: MyEvent,
  callback: ServerlessCallback
) {

  try {

    if (event.Source === "API") {
      // Return a success response using the callback function.
      return callback(null);
    }

    const twilioClient = context.getTwilioClient();

    const syncServiceSid = context.TWILIO_SYNC_SERVICE_SID || 'default';
    const assertionSigningKey = context.LINE_ASSERTION_SIGNING_KEY;
    const channelId = context.LINE_CHANNEL_ID;
    const privateKey = Runtime.getAssets()['/private_key.key'].open();

    const CAToken: CAToken = await getLineChannelAccessToken({ syncServiceSid: syncServiceSid, privateKey: privateKey, assertionSigningKey: assertionSigningKey, channelId: channelId });

    // create LINE SDK client
    const lineClient = new LineClient({
      channelAccessToken: CAToken.access_token,
      channelSecret: context.LINE_CHANNEL_SECRET
    });

    const conversation = await twilioClient.conversations.v1.conversations(event.ConversationSid).fetch();

    const attributes = JSON.parse(conversation.attributes);

    if (event.Body) {
      await lineClient.pushMessage(
        attributes.userId,
        { type: 'text', text: event.Body }
      );
    }

    if (event.Media) {

      const mediaObject = JSON.parse(event.Media) as {
        Sid: string;
        Filename: string;
        Size: number
      }[];

      if (mediaObject.length > 0) {

        let lineMessageList = [] as {
          type: "image";
          originalContentUrl: string;
          previewImageUrl: string;
        }[];

        for await (const mediaItem of mediaObject) {
          const retrieveMediaUrl = await fetch(`https://mcs.us1.twilio.com/v1/Services/${context.FLEX_CONVERSATION_SERVICE_SID}/Media/${mediaItem.Sid}`, {
            method: "GET",
            headers: {
              'Authorization': `Basic ${Buffer.from(`${context.ACCOUNT_SID}:${context.AUTH_TOKEN}`).toString('base64')}`
            }
          });

          const responseMedia = await retrieveMediaUrl.json();

          lineMessageList.push({ type: 'image', originalContentUrl: responseMedia.links.content_direct_temporary, previewImageUrl: responseMedia.links.content_direct_temporary })

        }

        await lineClient.pushMessage(
          attributes.userId,
          lineMessageList
        );

      }

    }


    // Return a success response using the callback function.
    return callback(null);


  } catch (err) {

    if (err instanceof Error) {
      return callback(err);
    } else {
      return callback(null, new Error('Unknown Error'));
    }

  }
};
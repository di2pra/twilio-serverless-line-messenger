import { Client as LineClient } from '@line/bot-sdk';
import '@twilio-labs/serverless-runtime-types';
import { Context, ServerlessCallback, ServerlessFunctionSignature } from '@twilio-labs/serverless-runtime-types/types';
import jose from 'node-jose';
import { DocumentInstance, DocumentListInstance } from 'twilio/lib/rest/sync/v1/service/document';
const fetch = require('node-fetch');

type MyEvent = {
  events?: {
    type: string;
    message: {
      type: string;
      id: string;
      text: string;
    },
    source: {
      type: string;
      userId: string;
    },
    replyToken: string;
  }[]
}

type MyContext = {
  ACCOUNT_SID: string;
  AUTH_TOKEN: string;
  FLEX_CONVERSATION_SERVICE_SID: string;
  CUSTOM_DOMAIN_NAME: string;
  DOMAIN_NAME: string;
  TWILIO_SYNC_SERVICE_SID: string;
  LINE_CHANNEL_SECRET: string;
  LINE_ASSERTION_SIGNING_KEY: string;
  FLEX_STUDIO_FLOW_SID: string;
  SERVICE_SID: string;
  LINE_CHANNEL_ID: string;
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

    if (!event.events) {
      throw new Error('No Message')
    }

    // retrieve incoming message infomation
    const incomingMessage = event.events.find(e => e.type === "message");

    if (!incomingMessage) {
      throw new Error('No Message')
    }

    const lineIdentity = `line:${incomingMessage.source.userId}`;

    const twilioClient = context.getTwilioClient();
    const conversationList = await twilioClient.conversations.v1.services(context.FLEX_CONVERSATION_SERVICE_SID).participantConversations.list({ identity: lineIdentity });

    const existingConversation = conversationList.find(conversation => conversation.conversationState !== 'closed');
    let conversationSid = existingConversation?.conversationSid;

    // init Line Client
    const syncServiceSid = context.TWILIO_SYNC_SERVICE_SID || 'default';
    const assertionSigningKey = context.LINE_ASSERTION_SIGNING_KEY;
    const channelId = context.LINE_CHANNEL_ID;
    const privateKey = Runtime.getAssets()['/private_key.key'].open();
    const CAToken: CAToken = await getLineChannelAccessToken({ syncServiceSid: syncServiceSid, privateKey: privateKey, assertionSigningKey: assertionSigningKey, channelId: channelId });

    const lineClient = new LineClient({
      channelAccessToken: CAToken.access_token,
      channelSecret: context.LINE_CHANNEL_SECRET
    });

    // Retrieve Line User Profile
    const userProfile = await lineClient.getProfile(incomingMessage.source.userId);

    if (!conversationSid) {

      const conversationCreated = await twilioClient.conversations.v1.conversations.create({
        friendlyName: `Line Conversation`,
        attributes: JSON.stringify({
          userId: incomingMessage.source.userId,
          name: userProfile.displayName
        })
      });

      // add Line User participant
      await twilioClient.conversations.v1.conversations(conversationCreated.sid).participants.create({
        identity: lineIdentity
      });

      await twilioClient.conversations.v1.conversations(conversationCreated.sid).webhooks
        .create({
          configuration: {
            filters: 'onMessageAdded',
            flowSid: context.FLEX_STUDIO_FLOW_SID
          },
          target: 'studio'
        });

      await twilioClient.conversations.conversations(conversationCreated.sid)
        .webhooks
        .create({
          target: 'webhook',
          configuration: {
            filters: 'onMessageAdded',
            method: 'POST',
            url: `https://${context.SERVICE_SID ? context.DOMAIN_NAME : context.CUSTOM_DOMAIN_NAME}/outbound`
          }
        });

      conversationSid = conversationCreated.sid;

    }

    switch (incomingMessage.message.type) {
      case "text":
        // add Line User Text Message to the Conversation
        await twilioClient.conversations.v1.conversations(conversationSid)
          .messages
          .create({
            author: userProfile.displayName,
            body: incomingMessage.message.text,
            xTwilioWebhookEnabled: 'true'
          });

        break;
      case "image":

        const getContentRequest = await fetch(`https://api-data.line.me/v2/bot/message/${incomingMessage.message.id}/content`, {
          method: "GET",
          headers: {
            'Authorization': `Bearer ${CAToken.access_token}`
          }
        });

        if (!getContentRequest.ok) {
          throw new Error('Error while retrieving Image Content');
        }

        const uploadContentRequest = await fetch(`https://mcs.us1.twilio.com/v1/Services/${context.FLEX_CONVERSATION_SERVICE_SID}/Media`, {
          method: "POST",
          headers: {
            'Authorization': `Basic ${Buffer.from(`${context.ACCOUNT_SID}:${context.AUTH_TOKEN}`).toString('base64')}`
          },
          body: await getContentRequest.blob()
        });

        if (!uploadContentRequest.ok) {
          throw new Error('Error while upload the content to twilio');
        }

        const responseUploadContent = await uploadContentRequest.json();

        // add Line User Text Message to the Conversation
        await twilioClient.conversations.v1.conversations(conversationSid)
          .messages
          .create({
            author: userProfile.displayName,
            mediaSid: responseUploadContent.sid,
            xTwilioWebhookEnabled: 'true'
          });


        break;
      default:
        break;
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
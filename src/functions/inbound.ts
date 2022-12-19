import { Client as LineClient } from '@line/bot-sdk';
import '@twilio-labs/serverless-runtime-types';
import { Context, ServerlessCallback, ServerlessFunctionSignature } from '@twilio-labs/serverless-runtime-types/types';
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
  /* ==============
  provided automatically by the serverless host in the cloud 
  =============== */
  SERVICE_SID: string;
  DOMAIN_NAME: string;
  /* ============== */
  ACCOUNT_SID: string;
  AUTH_TOKEN: string;
  FLEX_CONVERSATION_SERVICE_SID: string;
  TWILIO_SYNC_SERVICE_SID: string;
  LINE_CHANNEL_SECRET: string;
  LINE_ASSERTION_SIGNING_KEY_ID: string;
  FLEX_STUDIO_FLOW_SID: string;
  LINE_CHANNEL_ID: string;
  CUSTOM_DOMAIN_NAME: string; // in case you are running the code locally and you are using ngrok
}

type CAToken = {
  access_token: string;
  token_type: string;
  expires_in: number;
  key_id: string;
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
    const assertionSigningKeyId = context.LINE_ASSERTION_SIGNING_KEY_ID;
    const channelId = context.LINE_CHANNEL_ID;

    // First, get the path for the Asset
    const path = Runtime.getAssets()['/getLineChannelAccessToken.js'].path;

    // Next, you can use require() to import the library
    const module = require(path);

    const CAToken: CAToken = await module.getLineChannelAccessToken({ syncServiceSid: syncServiceSid, assertionSigningKeyId: assertionSigningKeyId, channelId: channelId });

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

      // Set the conversation webhook
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

        // add Line User Image to the Conversation
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
      return callback(new Error('Unknown Error'));
    }

  }
};
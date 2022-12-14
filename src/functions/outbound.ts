import { Client as LineClient } from '@line/bot-sdk';
import '@twilio-labs/serverless-runtime-types';
import { Context, ServerlessCallback, ServerlessFunctionSignature } from '@twilio-labs/serverless-runtime-types/types';
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

export const handler: ServerlessFunctionSignature<MyContext, MyEvent> = async function (
  context: Context<MyContext>,
  event: MyEvent,
  callback: ServerlessCallback
) {

  try {

    // as this webhook will be triggered for every single message, if the call is made when we receive a message from Line then do not proceed
    if (event.Source === "API") {
      // Return a success response using the callback function.
      return callback(null);
    }

    // get the Twilio client
    const twilioClient = context.getTwilioClient();

    const syncServiceSid = context.TWILIO_SYNC_SERVICE_SID || 'default';
    const assertionSigningKey = context.LINE_ASSERTION_SIGNING_KEY;
    const channelId = context.LINE_CHANNEL_ID;

    // First, get the path for the Asset
    const path = Runtime.getAssets()['/getLineChannelAccessToken.js'].path;

    // Next, you can use require() to import the library
    const module = require(path);

    const CAToken: CAToken = await module.getLineChannelAccessToken({ syncServiceSid: syncServiceSid, assertionSigningKey: assertionSigningKey, channelId: channelId });

    // create LINE SDK client
    const lineClient = new LineClient({
      channelAccessToken: CAToken.access_token,
      channelSecret: context.LINE_CHANNEL_SECRET
    });

    // retrieve the conversation
    const conversation = await twilioClient.conversations.v1.conversations(event.ConversationSid).fetch();

    // parse the conversation attributes where we have stored the Line User Id
    const attributes = JSON.parse(conversation.attributes);

    // if the message contains a text body, then send the text message to the line user
    if (event.Body) {
      await lineClient.pushMessage(
        attributes.userId,
        { type: 'text', text: event.Body }
      );
    }

    // if the message contains a media object, then send it to the line user
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
      return callback(new Error('Unknown Error'));
    }

  }
};
import { Client as LineClient } from '@line/bot-sdk';
import '@twilio-labs/serverless-runtime-types';
import { Context, ServerlessCallback, ServerlessFunctionSignature } from '@twilio-labs/serverless-runtime-types/types';

type MyEvent = {
  Source: string;
  ConversationSid: string;
  Body: string;
}

type MyContext = {
  ACCOUNT_SID: string;
  AUTH_TOKEN: string;
  FLEX_CONVERSATION_SERVICE_SID: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
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

    // create LINE SDK client
    const lineClient = new LineClient({
      channelAccessToken: context.LINE_CHANNEL_ACCESS_TOKEN,
      channelSecret: context.LINE_CHANNEL_SECRET
    });

    const conversation = await twilioClient.conversations.v1.conversations(event.ConversationSid).fetch();

    const attributes = JSON.parse(conversation.attributes);

    const response = await lineClient.replyMessage(
      attributes.replyToken,
      { type: 'text', text: event.Body }
    );

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
import '@twilio-labs/serverless-runtime-types';
import { Context, ServerlessCallback, ServerlessFunctionSignature } from '@twilio-labs/serverless-runtime-types/types';

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
  DOMAIN_NAME: string;
  FLEX_STUDIO_FLOW_SID: string;
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

    const incomingMessage = event.events.find(e => e.type === "message");

    if (!incomingMessage) {
      throw new Error('No Message')
    }

    const lineIdentity = `line:${incomingMessage.source.userId}`;

    const twilioClient = context.getTwilioClient();
    const conversationList = await twilioClient.conversations.v1.services(context.FLEX_CONVERSATION_SERVICE_SID).participantConversations.list({ identity: lineIdentity });

    const existingConversation = conversationList.find(conversation => conversation.conversationState !== 'closed');

    if (!existingConversation) {

      const conversationCreated = await twilioClient.conversations.v1.conversations.create({
        friendlyName: `Line Conversation`,
        attributes: JSON.stringify({
          replyToken: incomingMessage.replyToken
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
            url: `https://${context.DOMAIN_NAME}/outbound`
          }
        });

      // add Line User Message to the Conversation
      await twilioClient.conversations.v1.conversations(conversationCreated.sid)
        .messages
        .create({
          author: lineIdentity, body: incomingMessage.message.text,
          xTwilioWebhookEnabled: 'true'
        });

    } else {

      // add Line User Message to the Conversation
      await twilioClient.conversations.v1.conversations(existingConversation.conversationSid)
        .messages
        .create({
          author: lineIdentity,
          body: incomingMessage.message.text,
          xTwilioWebhookEnabled: 'true'
        });

      const existingAttribute = JSON.parse(existingConversation.conversationAttributes);

      await twilioClient.conversations.v1.conversations(existingConversation.conversationSid)
        .update({
          attributes: JSON.stringify({ ...existingAttribute, replyToken: incomingMessage.replyToken })
        })

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
import {
  type AgentSessionEventWebhookPayload,
  LinearWebhooks,
} from "@linear/sdk";
import {
  handleOAuthAuthorize,
  handleOAuthCallback,
  getOAuthToken,
} from "./lib/oauth";
import { AgentClient } from "./lib/agent/agentClient";

/**
 * This Cloudflare worker handles all requests for the demo agent.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Weather bot says hello! 🌤️", { status: 200 });
    }

    // Handle OAuth authorize route
    if (url.pathname === "/oauth/authorize") {
      return handleOAuthAuthorize(request, env);
    }

    // Handle OAuth callback route
    if (url.pathname === "/oauth/callback") {
      return handleOAuthCallback(request, env);
    }

    // Handle webhook route
    if (url.pathname === "/webhook" && request.method === "POST") {
      const token = await getOAuthToken(env);
      if (!token) {
        return new Response("Linear OAuth token not found", { status: 500 });
      }

      const linearWebhooks = new LinearWebhooks(env.LINEAR_WEBHOOK_SECRET);
      await this.handleWebhook(
        request,
        linearWebhooks,
        token,
        env.OPENAI_API_KEY
      );
    }

    return new Response("OK", { status: 200 });
  },

  /**
   * Handle a Linear webhook.
   * @param request The request object.
   * @param linearWebhooks The Linear webhooks class, used to parse the webhook payload.
   * @param linearAccessToken The Linear access token.
   * @param openaiApiKey The OpenAI API key.
   * @returns A promise that resolves when the webhook is handled.
   */
  async handleWebhook(
    request: Request,
    linearWebhooks: LinearWebhooks,
    linearAccessToken: string,
    openaiApiKey: string
  ): Promise<void> {
    const text = await request.text();
    const payloadBuffer = Buffer.from(text);
    const parsedPayload = linearWebhooks.parseData(
      payloadBuffer,
      request.headers.get("linear-signature") || ""
    );

    if (parsedPayload.type !== "AgentSessionEvent") {
      return;
    }

    const webhook = parsedPayload as AgentSessionEventWebhookPayload;
    const agentClient = new AgentClient(linearAccessToken, openaiApiKey);
    console.log("Webhook:", webhook);
    await agentClient.handleUserPrompt(
      this.generateUserPrompt(webhook),
      webhook.agentSession.id
    );
    return;
  },

  /**
   * Generate a user prompt for the agent based on the webhook payload.
   * Modify this as needed if you want to give the agent more context by querying additional APIs.
   *
   * @param webhook The webhook payload.
   * @returns The user prompt.
   */
  generateUserPrompt(webhook: AgentSessionEventWebhookPayload): string {
    if (webhook.action === "created") {
      const issueTitle = webhook.agentSession.issue?.title;
      const commentBody = webhook.agentSession.comment?.body;
      return `Issue: ${issueTitle}\n\nTask: ${commentBody}`;
    } else {
      return `Task: ${webhook.agentActivity?.content.body}`;
    }
  },
};

/**
 * Environment variables for the demo agent.
 */
export interface Env {
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  LINEAR_WEBHOOK_SECRET: string;
  REDIRECT_URI: string;
  ENVIRONMENT: string;
  WEATHER_BOT_TOKENS: KVNamespace;
  OPENAI_API_KEY: string;
}

import OpenAI from "openai";
import { getCoordinates, getWeather } from "./lib/agent/tools";
import type { ChatCompletionMessageParam } from "openai/resources/index";
import { type AgentSessionEventWebhookPayload, LinearClient, LinearWebhooks } from "@linear/sdk";
import { prompt } from "./lib/agent/prompt";
import { handleOAuthAuthorize, handleOAuthCallback, getOAuthToken } from "./lib/oauth";

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
      const linearClient = new LinearClient({
        accessToken: token,
      });
      await this.handleWebhook(request, linearWebhooks, linearClient, env.OPENAI_API_KEY);
    }

    return new Response("OK", { status: 200 });
  },

  async handleWebhook(
    request: Request,
    linearWebhooks: LinearWebhooks,
    linearClient: LinearClient,
    openaiApiKey: string
  ): Promise<void> {
    const text = await request.text();
    const payloadBuffer = Buffer.from(text);
    const parsedPayload = linearWebhooks.parseData(payloadBuffer, request.headers.get("linear-signature") || "");

    if (parsedPayload.type !== "AgentSessionEvent") {
      return;
    }

    // Type the payload as AgentSessionEventWebhookPayload
    const webhook = parsedPayload as AgentSessionEventWebhookPayload;
    // const session = await linearClient.agentSession(webhook.agentSession.id);
    // const activities = await session.activities();
    // if (webhook.action === "created") {
    await this.runAgentMode(
      webhook.agentActivity?.content.body || webhook.agentSession.comment?.body || "",
      linearClient,
      openaiApiKey,
      webhook.agentSession.id
    );
    // }
    return;
  },

  async callOpenAI(messages: ChatCompletionMessageParam[], apiKey: string) {
    try {
      const openai = new OpenAI({
        apiKey,
      });

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
      });

      return response.choices[0]?.message?.content || "No response";
    } catch (error) {
      throw new Error(`OpenAI API error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  },

  // Autopilot execution logic
  async runAgentMode(userPrompt: string, linearClient: LinearClient, openaiApiKey: string, agentSessionId: string) {
    const messages = [
      { role: "system", content: prompt },
      { role: "user", content: userPrompt },
    ] as ChatCompletionMessageParam[];

    let taskComplete = false;
    let iterations = 0;
    const maxIterations = 10; // Prevent infinite loops

    while (!taskComplete && iterations < maxIterations) {
      iterations++;

      try {
        const response = await this.callOpenAI(messages, openaiApiKey);

        if (response?.startsWith("THINKING:")) {
          // Send thinking response
          await linearClient.createAgentActivity({
            agentSessionId,
            content: {
              type: "thought",
              body: response.replace("THINKING:", "").trim(),
            },
          });

          // Add to conversation history
          messages.push({ role: "assistant", content: response });

          // Continue the loop for next cycle
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else if (response?.startsWith("ACTION:")) {
          // Parse action
          const actionMatch = response.match(/ACTION:\s*(\w+)\(([^)]+)\)/);
          if (actionMatch) {
            const [, toolName, params] = actionMatch;

            // PART 1: Send "Using..." action
            const actionDescription =
              toolName === "getCoordinates"
                ? "Getting coordinates for"
                : toolName === "getWeather"
                  ? "Getting weather for"
                  : "Executing";
            await linearClient.createAgentActivity({
              agentSessionId,
              content: {
                type: "action",
                action: toolName,
                body: actionDescription,
                parameter: params || "",
              },
            });

            // Execute the tool
            let toolResult = "Tool executed successfully";
            if (toolName === "getCoordinates" && params) {
              toolResult = JSON.stringify(await getCoordinates(params.replace(/"/g, "")));
            } else if (toolName === "getWeather" && params) {
              const paramParts = params.split(",").map((p: string) => parseFloat(p.trim()));
              if (
                paramParts.length >= 2 &&
                // @ts-ignore
                !isNaN(paramParts[0]) &&
                // @ts-ignore
                !isNaN(paramParts[1])
              ) {
                const lat = paramParts[0]!;
                const lng = paramParts[1]!;
                toolResult = JSON.stringify(await getWeather(lng, lat));
              }
            }

            // PART 2: Send "Got..." action with result
            const resultDescription =
              toolName === "getCoordinates"
                ? "Got coordinates for"
                : toolName === "getWeather"
                  ? "Got weather for"
                  : "Executed";
            await linearClient.createAgentActivity({
              agentSessionId,
              content: {
                type: "action",
                action: toolName,
                body: resultDescription,
                parameter: params || "",
              },
            });

            // Add tool result to conversation for next LLM call
            messages.push({ role: "assistant", content: response });
            messages.push({
              role: "user",
              content: `Tool result: ${toolResult}`,
            });

            // Continue the loop for next cycle
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } else if (response?.startsWith("RESPONSE:")) {
          // Final response - task complete
          await linearClient.createAgentActivity({
            agentSessionId,
            content: {
              type: "response",
              body: response.replace("RESPONSE:", "").trim(),
            },
          });
          taskComplete = true;
        } else if (response?.startsWith("ELICITATION:")) {
          // Elicit more information
          await linearClient.createAgentActivity({
            agentSessionId,
            content: {
              type: "elicitation",
              body: response.replace("ELICITATION:", "").trim(),
            },
          });
          taskComplete = true;
        } else if (response?.startsWith("ERROR:")) {
          // Error - task complete
          await linearClient.createAgentActivity({
            agentSessionId,
            content: {
              type: "error",
              body: response.replace("ERROR:", "").trim(),
            },
          });
          taskComplete = true;
        } else {
          // Fallback - treat as thinking
          await linearClient.createAgentActivity({
            agentSessionId,
            content: {
              type: "thought",
              body: response || "Agent is processing...",
            },
          });
          messages.push({
            role: "assistant",
            content: response || "Processing...",
          });
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        await linearClient.createAgentActivity({
          agentSessionId,
          content: {
            type: "error",
            body: `Agent error: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        });
        taskComplete = true;
      }
    }
  },
};

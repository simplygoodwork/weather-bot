import { OAuthTokenResponse } from "./types";

const OAUTH_TOKEN_KEY = "linear_oauth_token";

/**
 * Handles the OAuth authorization request.
 * Redirects the user to Linear's OAuth authorization page.
 * @param request - The request object.
 * @param env - The environment variables.
 * @returns A response object.
 */
export function handleOAuthAuthorize(request: Request, env: Env): Response {
  const scope = "read,write,app:assignable,app:mentionable";

  const authUrl = new URL("https://linear.app/oauth/authorize");
  authUrl.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${env.WORKER_URL}/oauth/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("actor", "app");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
    },
  });
}

/**
 * Handles the OAuth callback from Linear by exchanging the authorization code for an access token and storing it.
 * @param request - The request object.
 * @param env - The environment variables.
 * @returns A response object.
 */
export async function handleOAuthCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`OAuth Error: ${error}`, { status: 400 });
  }

  if (!code) {
    return new Response("Missing required OAuth parameters", { status: 400 });
  }

  try {
    // Exchange authorization code for access token
    const tokenResponse = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env.LINEAR_CLIENT_ID,
        client_secret: env.LINEAR_CLIENT_SECRET,
        code,
        redirect_uri: `${env.WORKER_URL}/oauth/callback`,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return new Response(`Token exchange failed: ${errorText}`, {
        status: 400,
      });
    }

    const tokenData = (await tokenResponse.json()) as OAuthTokenResponse;
    await setOAuthToken(env, tokenData.access_token);

    return new Response(
      `
      <html>
        <head><title>OAuth Success</title></head>
        <body>
          <h1>OAuth Authorization Successful!</h1>
          <p>Access token received and stored securely. You can now interact with weather bot!</p>
        </body>
      </html>
    `,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html",
        },
      }
    );
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    return new Response(`Token exchange error: ${errorMessage}`, {
      status: 500,
    });
  }
}

/**
 * Retrieves the stored OAuth token.
 * This implementation uses a KV namespace to store the token.
 * @param env - The environment variables.
 * @returns The OAuth token.
 */
export async function getOAuthToken(env: Env): Promise<string | null> {
  if (!env.WEATHER_BOT_TOKENS) {
    return null;
  }
  return await env.WEATHER_BOT_TOKENS.get(OAUTH_TOKEN_KEY);
}

/**
 * Stores the OAuth token.
 * This implementation uses a KV namespace to store the token.
 * @param env - The environment variables.
 * @param token - The OAuth token.
 */
export async function setOAuthToken(env: Env, token: string): Promise<void> {
  await env.WEATHER_BOT_TOKENS.put(OAUTH_TOKEN_KEY, token);
}

/**
 * Checks if OAuth token exists.
 * @param env - The environment variables.
 * @returns True if the OAuth token exists, false otherwise.
 */
export async function hasOAuthToken(env: Env): Promise<boolean> {
  const token = await getOAuthToken(env);
  return token !== null;
}

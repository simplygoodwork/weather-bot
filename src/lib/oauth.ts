/**
 * OAuth helper for Linear integration
 */

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface OAuthEnv {
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  REDIRECT_URI: string;
  WEATHER_BOT_TOKENS: KVNamespace;
}

const OAUTH_TOKEN_KEY = "linear_oauth_token";

/**
 * Handles the OAuth authorization request.
 * Redirects the user to Linear's OAuth authorization page.
 */
export function handleOAuthAuthorize(request: Request, env: OAuthEnv): Response {
  const scope = "read,write,app:assignable,app:mentionable";

  const authUrl = new URL("https://linear.app/oauth/authorize");
  authUrl.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", env.REDIRECT_URI);
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
 * Handles the OAuth callback from Linear.
 * Exchanges the authorization code for an access token and stores it in KV.
 */
export async function handleOAuthCallback(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  // Check for OAuth errors
  if (error) {
    return new Response(`OAuth Error: ${error}`, { status: 400 });
  }

  // Validate required parameters
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
        redirect_uri: env.REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return new Response(`Token exchange failed: ${errorText}`, { status: 400 });
    }

    const tokenData = (await tokenResponse.json()) as OAuthTokenResponse;

    // Store just the access token in KV
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
    return new Response(`Token exchange error: ${errorMessage}`, { status: 500 });
  }
}

/**
 * Retrieves the stored OAuth token from KV
 */
export async function getOAuthToken(env: OAuthEnv): Promise<string | null> {
  if (!env.WEATHER_BOT_TOKENS) {
    return null;
  }
  return await env.WEATHER_BOT_TOKENS.get(OAUTH_TOKEN_KEY);
}

/**
 * Stores the OAuth token in KV
 */
export async function setOAuthToken(env: OAuthEnv, token: string): Promise<void> {
  await env.WEATHER_BOT_TOKENS.put(OAUTH_TOKEN_KEY, token);
}

/**
 * Checks if OAuth token exists
 */
export async function hasOAuthToken(env: OAuthEnv): Promise<boolean> {
  const token = await getOAuthToken(env);
  return token !== null;
} 
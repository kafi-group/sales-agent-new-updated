/**
 * Vercel Edge Function — restart/redeploy Kafi-Sales-Agent on Railway.
 * URL: /ops/restart-backend  (rewritten from vercel.json; not proxied to Railway)
 *
 * Env (Vercel Production): RAILWAY_API_TOKEN, RAILWAY_SERVICE_ID,
 * RAILWAY_ENVIRONMENT_ID, OPS_REDEPLOY_PIN
 */

export const config = { runtime: "edge" };

const RAILWAY_GQL = "https://backboard.railway.com/graphql/v2";

async function railwayGql(token, query, variables) {
  const res = await fetch(RAILWAY_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const token = (process.env.RAILWAY_API_TOKEN || "").trim();
  const serviceId = (process.env.RAILWAY_SERVICE_ID || "").trim();
  const environmentId = (process.env.RAILWAY_ENVIRONMENT_ID || "").trim();
  const expectedPin = (process.env.OPS_REDEPLOY_PIN || "").trim();

  if (!token || !serviceId || !environmentId || !expectedPin) {
    return Response.json(
      {
        ok: false,
        error:
          "Railway restart is not configured on Vercel. Set RAILWAY_API_TOKEN, RAILWAY_SERVICE_ID, RAILWAY_ENVIRONMENT_ID, and OPS_REDEPLOY_PIN.",
        configured: {
          token: Boolean(token),
          serviceId: Boolean(serviceId),
          environmentId: Boolean(environmentId),
          pin: Boolean(expectedPin),
        },
      },
      { status: 503 },
    );
  }

  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const pin = String(body.pin || "").trim();
  if (!pin || pin !== expectedPin) {
    return Response.json({ ok: false, error: "Invalid emergency PIN" }, { status: 403 });
  }

  const mode = body.mode === "redeploy" ? "redeploy" : "restart";

  try {
    if (mode === "redeploy") {
      const result = await railwayGql(
        token,
        `mutation Redeploy($serviceId: String!, $environmentId: String!) {
          serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
        }`,
        { serviceId, environmentId },
      );
      if (result.errors?.length) {
        return Response.json(
          { ok: false, error: result.errors.map((e) => e.message).join("; ") },
          { status: 502 },
        );
      }
      return Response.json({
        ok: true,
        action: "redeploy",
        message:
          "Railway redeploy started. Wait 1–2 minutes, then hard-refresh. Health should return OK.",
      });
    }

    const list = await railwayGql(
      token,
      `query LatestDeployment($serviceId: String!, $environmentId: String!) {
        deployments(
          first: 1
          input: { serviceId: $serviceId, environmentId: $environmentId }
        ) {
          edges { node { id status } }
        }
      }`,
      { serviceId, environmentId },
    );
    if (list.errors?.length) {
      return Response.json(
        { ok: false, error: list.errors.map((e) => e.message).join("; ") },
        { status: 502 },
      );
    }
    const deploymentId = list.data?.deployments?.edges?.[0]?.node?.id;
    if (!deploymentId) {
      return Response.json(
        { ok: false, error: "No Railway deployment found to restart" },
        { status: 404 },
      );
    }

    const restarted = await railwayGql(
      token,
      `mutation Restart($id: String!) {
        deploymentRestart(id: $id)
      }`,
      { id: deploymentId },
    );
    if (restarted.errors?.length) {
      const redeploy = await railwayGql(
        token,
        `mutation Redeploy($serviceId: String!, $environmentId: String!) {
          serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
        }`,
        { serviceId, environmentId },
      );
      if (redeploy.errors?.length) {
        return Response.json(
          {
            ok: false,
            error: [
              ...restarted.errors.map((e) => e.message),
              ...redeploy.errors.map((e) => e.message),
            ].join("; "),
          },
          { status: 502 },
        );
      }
      return Response.json({
        ok: true,
        action: "redeploy",
        deploymentId,
        message:
          "Restart was not available; Railway redeploy started instead. Wait 1–2 minutes, then hard-refresh.",
      });
    }

    return Response.json({
      ok: true,
      action: "restart",
      deploymentId,
      message:
        "Railway backend restart triggered (no rebuild). Wait ~30–60 seconds, then hard-refresh.",
    });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Railway API call failed",
      },
      { status: 500 },
    );
  }
}

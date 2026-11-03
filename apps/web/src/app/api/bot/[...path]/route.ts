import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { isBotProxyPathAllowed } from "@/lib/botProxyAllowlist";

/**
 * Proxy navigateur ➜ bot. Le secret BOT_API_SECRET et l'identité Discord (issue de la session serveur) sont
 * injectés ici et jamais fournis par le client (SEC-06). Seules les routes de gestion sont relayées (SEC-13).
 */
async function handleProxy(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const session = await getServerSession(authOptions);
  const discordId = (session?.user as { id?: string } | undefined)?.id;
  if (!discordId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const segments = (await params).path;
  const path = (segments[0] === "api" ? segments.slice(1) : segments).join("/");
  if (!isBotProxyPathAllowed(path)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const botApiSecret = process.env.BOT_API_SECRET;
  if (!botApiSecret) {
    console.error("BOT_API_SECRET is missing");
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const url = new URL(request.url);
  const botApiUrl = process.env.NEXT_PUBLIC_BOT_API_URL || "http://localhost:8080";
  const targetUrl = `${botApiUrl}/api/${path}${url.search}`;

  // Seuls les en-têtes nécessaires sont transmis : aucun cookie ni jeton du navigateur n'atteint le bot.
  const headers = new Headers({
    Authorization: `Bearer ${botApiSecret}`,
    "X-Discord-User-Id": discordId,
  });

  const hasBody = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
  const textBody = hasBody ? await request.text() : "";
  if (textBody) headers.set("Content-Type", "application/json");

  // requireGuildAdmin lit aussi guildId dans la query ou le corps ; l'en-tête sert de repli (DELETE, GET).
  let guildId = url.searchParams.get("guildId") || url.searchParams.get("guild_id");
  if (!guildId && textBody) {
    try {
      const body = JSON.parse(textBody) as { guildId?: unknown; guild_id?: unknown };
      const candidate = body.guildId ?? body.guild_id;
      if (typeof candidate === "string") guildId = candidate;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }
  if (guildId) headers.set("X-Guild-Id", guildId);

  try {
    const res = await fetch(targetUrl, {
      method: request.method,
      headers,
      ...(textBody ? { body: textBody } : {}),
    });

    const contentType = res.headers.get("content-type");
    const payload = contentType?.includes("application/json") ? await res.json() : { error: await res.text() };

    return NextResponse.json(payload, { status: res.status });
  } catch (error: unknown) {
    console.error(`Proxy Error to ${targetUrl}:`, error);
    return NextResponse.json({ error: "Bot unreachable" }, { status: 502 });
  }
}

export const GET = handleProxy;
export const POST = handleProxy;
export const PUT = handleProxy;
export const PATCH = handleProxy;
export const DELETE = handleProxy;

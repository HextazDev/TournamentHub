import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { BOT_UNREACHABLE, botAccessError, relayedBotError } from "@/lib/accessErrors";
import { getServerLocale } from "@/i18n/server";

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const guildId = url.searchParams.get("guildId");
  if (!guildId) {
    return NextResponse.json({ error: "Missing guildId parameter" }, { status: 400 });
  }

  const botApiUrl = process.env.NEXT_PUBLIC_BOT_API_URL || "http://localhost:8080";
  const botApiSecret = process.env.BOT_API_SECRET;

  if (!botApiSecret) {
    console.error("BOT_API_SECRET is missing");
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const discordId = (session.user as any)?.id || "";

  try {
    const res = await fetch(`${botApiUrl}/api/discord/roles?guildId=${guildId}`, {
      headers: {
        Authorization: `Bearer ${botApiSecret}`,
        "X-Discord-User-Id": discordId,
        "X-Guild-Id": guildId,
      },
      next: { revalidate: 60 } // cache for 1 minute
    });

    if (!res.ok) {
      // SEC-18 : refus d'accès traduit, jamais le texte brut du bot.
      return NextResponse.json(relayedBotError(await res.text(), await getServerLocale()), { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("Error calling bot API:", error);
    return NextResponse.json(botAccessError(BOT_UNREACHABLE, await getServerLocale()), { status: 502 });
  }
}

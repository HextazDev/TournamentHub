import { NextResponse } from "next/server";
import { readWebServerEnvironment } from "../../../lib/config";

export async function GET() {
  try {
    readWebServerEnvironment(process.env);
    return NextResponse.json(
      { status: "ok" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

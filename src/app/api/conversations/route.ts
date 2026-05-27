import { NextResponse } from "next/server";
import { createConversation, listConversations } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");

  if (!userId) {
    return NextResponse.json({ error: "Missing userId." }, { status: 400 });
  }

  try {
    const conversations = await listConversations(userId);
    return NextResponse.json({ conversations });
  } catch (error) {
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { userId?: string; title?: string };

    if (!body.userId) {
      return NextResponse.json({ error: "Missing userId." }, { status: 400 });
    }

    const conversation = await createConversation(body.userId, body.title);

    return NextResponse.json({ conversation }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return "Unexpected server error.";
}

/**
 * app/v1/models/route.ts
 *
 * OpenAI Models API endpoint (no /api prefix).
 */
import { NextResponse } from "next/server";
import { listProviders } from "@/lib/db/providers";

export async function GET(): Promise<Response> {
  const providers = await listProviders({ enabledOnly: true });
  
  const models: string[] = [];
  for (const provider of providers) {
    for (const clientModel of Object.keys(provider.modelMapping)) {
      if (!models.includes(clientModel)) {
        models.push(clientModel);
      }
    }
  }

  return NextResponse.json({
    object: "list",
    data: models.map((id) => ({
      id,
      object: "model",
      created: Date.now(),
      owned_by: "relay-ab",
    })),
  });
}

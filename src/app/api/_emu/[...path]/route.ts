/**
 * app/api/_emu/[...path]/route.ts
 *
 * Embedded Vercel REST API emulator (dev/test only).
 *
 * Mounts `@emulators/vercel` so that calls to the Vercel SDK whose
 * `serverURL` is `http://localhost:3000/api/_emu/vercel` are served
 * from in-process state. The Hono router inside the emulator mirrors
 * the real Vercel REST surface.
 *
 * Production guard: if `EMULATE_VERCEL_LOCAL` is off or `NODE_ENV` is
 * production, the catch-all returns 404 so we can't be tricked into
 * running mocks on a live deployment.
 */
import { createEmulateHandler } from "@emulators/adapter-next";
import * as vercel from "@emulators/vercel";
import { isEmulatorEnabled } from "@/lib/config";

const handler = createEmulateHandler({
  services: {
    vercel: {
      emulator: vercel,
      seed: {
        users: [{ username: "developer", name: "Developer", email: "dev@example.com" }],
        teams: [{ slug: "my-team", name: "My Team" }],
        projects: [{ name: "relay-ab", team: "my-team", framework: "nextjs" }],
      },
    },
  },
});

function gate(): Response | null {
  if (!isEmulatorEnabled()) {
    return new Response("Emulator disabled in production", { status: 404 });
  }
  return null;
}

export async function GET(request: Request): Promise<Response> {
  const blocked = gate();
  if (blocked) return blocked;
  return (handler.GET as unknown as (req: Request) => Promise<Response>)(request);
}

export async function POST(request: Request): Promise<Response> {
  const blocked = gate();
  if (blocked) return blocked;
  return (handler.POST as unknown as (req: Request) => Promise<Response>)(request);
}

export async function PUT(request: Request): Promise<Response> {
  const blocked = gate();
  if (blocked) return blocked;
  return (handler.PUT as unknown as (req: Request) => Promise<Response>)(request);
}

export async function PATCH(request: Request): Promise<Response> {
  const blocked = gate();
  if (blocked) return blocked;
  return (handler.PATCH as unknown as (req: Request) => Promise<Response>)(request);
}

export async function DELETE(request: Request): Promise<Response> {
  const blocked = gate();
  if (blocked) return blocked;
  return (handler.DELETE as unknown as (req: Request) => Promise<Response>)(request);
}

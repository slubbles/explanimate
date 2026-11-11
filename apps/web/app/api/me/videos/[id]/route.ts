import { NextResponse } from "next/server";
import { SIGNIN_ERROR, authEnabled, sessionUser } from "../../../../../lib/auth";
import { getD1Db } from "../../../../../lib/db";
import { limitRequest } from "../../../../../lib/guard";
import { listJobs, removeJob } from "../../../../../lib/jobs";
import { ensureUsageTables } from "../../../../../lib/usage";
import { NO_STORE } from "../../../../../lib/view";
import { deleteUserVideo } from "../../../../../lib/videos";
import { withErrors } from "../../../../../lib/route";
import { checkOrigin } from "../../../../../lib/security";

export const runtime = "nodejs";

/**
 * Delete one of the signed-in account's videos: its job folder and its videos row
 * (lib/videos.ts checks ownership). Anything else (auth off, a bad id, or someone else's
 * video) answers 404, so one account cannot probe another's ids.
 */
export const DELETE = withErrors("me-video.DELETE", async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const crossSite = checkOrigin(req);
  if (crossSite) return crossSite;
  const limited = limitRequest(req, "me-video-delete");
  if (limited) return limited;
  if (!authEnabled()) return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
  const { id } = await ctx.params;
  if (!/^[a-f0-9]{12}$/.test(id)) return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
  const user = await sessionUser(req);
  if (!user) return NextResponse.json({ error: SIGNIN_ERROR }, { status: 401, headers: NO_STORE });
  const db = getD1Db();
  await ensureUsageTables(db);
  const r = await deleteUserVideo(user.id, id, listJobs(), db, removeJob);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
});

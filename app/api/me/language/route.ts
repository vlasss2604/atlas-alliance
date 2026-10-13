import { eq } from "drizzle-orm";

import { errorResponse, HttpError, requireMutation } from "@/src/server/auth/guards";
import { users } from "@/src/server/db/schema";
import { getDb } from "@/src/server/runtime";

export async function PATCH(req: Request): Promise<Response> {
  try {
    const db = getDb();
    const session = await requireMutation(db, req);
    const body = (await req.json().catch(() => ({}))) as { language?: string };
    if (body.language !== "RU" && body.language !== "EN") {
      throw new HttpError(400, "INVALID_LANGUAGE");
    }
    await db
      .update(users)
      .set({ language: body.language })
      .where(eq(users.id, session.userId));
    return Response.json({ language: body.language });
  } catch (e) {
    return errorResponse(e);
  }
}

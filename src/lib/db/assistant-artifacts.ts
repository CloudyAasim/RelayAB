/**
 * src/lib/db/assistant-artifacts.ts
 *
 * Media the assistant produced, so a conversation can show a picture or play a
 * sound instead of describing one.
 *
 * Two shapes, because the upstreams differ. Images and video normally hand back
 * a durable CDN link, and those rows keep the link and nothing else — the
 * serving route redirects, so a 2 MB image is never copied into the database.
 * Audio has no link at all: the endpoint answers with bytes, and until those
 * bytes were kept they were discarded after their length was measured. Those
 * rows carry the bytes.
 *
 * Every read is scoped to the owner. An artifact id from another account is
 * simply not found, which is the same rule the threads and messages follow.
 */
import { generateId } from "../crypto/hashing";
import { getOne, run } from "./sqlite";

export type ArtifactKind = "image" | "audio" | "video";

export interface AssistantArtifact {
  id: string;
  userId: string;
  threadId: string;
  kind: ArtifactKind;
  /** The upstream's own link, when it had one. */
  url: string | null;
  bytes: Uint8Array | null;
  contentType: string;
  createdAt: string;
}

/** What the conversation and the model are shown: a reference, not the payload. */
export interface ArtifactRef {
  id: string;
  kind: ArtifactKind;
  contentType: string;
  url: string;
}

export function artifactRef(row: Pick<AssistantArtifact, "id" | "kind" | "contentType">): ArtifactRef {
  return {
    id: row.id,
    kind: row.kind,
    contentType: row.contentType,
    // Session-scoped and owner-scoped by the route below, unlike the upstream
    // link, which is typically a long-lived CDN URL the model would otherwise
    // have to copy around and the reader would have no way to revoke.
    url: `/api/assistant/artifacts/${row.id}`,
  };
}

export async function saveAssistantArtifact(input: {
  userId: string;
  threadId: string;
  kind: ArtifactKind;
  url?: string | null;
  bytes?: Uint8Array | null;
  contentType: string;
}): Promise<AssistantArtifact> {
  const row: AssistantArtifact = {
    id: generateId(),
    userId: input.userId,
    threadId: input.threadId,
    kind: input.kind,
    url: input.url ?? null,
    bytes: input.bytes ?? null,
    contentType: input.contentType,
    createdAt: new Date().toISOString(),
  };
  run(
    `INSERT INTO assistant_artifacts
       (id, user_id, thread_id, kind, url, bytes, content_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.userId, row.threadId, row.kind, row.url, row.bytes, row.contentType, row.createdAt],
  );
  return row;
}

interface ArtifactRow {
  id: string;
  user_id: string;
  thread_id: string;
  kind: string;
  url: string | null;
  bytes: Uint8Array | null;
  content_type: string;
  created_at: string;
}

function rowToArtifact(row: ArtifactRow): AssistantArtifact {
  return {
    id: row.id,
    userId: row.user_id,
    threadId: row.thread_id,
    kind: row.kind as ArtifactKind,
    url: row.url,
    bytes: row.bytes ? new Uint8Array(row.bytes) : null,
    contentType: row.content_type,
    createdAt: row.created_at,
  };
}

/**
 * Read one artifact, scoped to its owner.
 *
 * The owner check is in the WHERE clause rather than applied afterwards, so a
 * foreign id is indistinguishable from one that never existed.
 */
export async function getAssistantArtifact(
  id: string,
  userId: string,
): Promise<AssistantArtifact | null> {
  if (!id || !userId) return null;
  const row = getOne<ArtifactRow>(
    "SELECT * FROM assistant_artifacts WHERE id = ? AND user_id = ?",
    [id, userId],
  );
  return row ? rowToArtifact(row) : null;
}

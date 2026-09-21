import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listAllApiKeys, listApiKeysByUser } from "@/lib/db/keys";
import { listUsers } from "@/lib/db/users";
import { Nav } from "@/components/layouts/Nav";
import { Card, CardHeader } from "@/components/ui/Card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { formatCredits, formatDate, formatNumber } from "@/lib/utils";
import { CreateKeyButton } from "./CreateKeyButton";
import { KeyActions } from "./KeyActions";

export default async function AdminKeysPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/dashboard");

  const [keysResult, usersResult] = await Promise.all([
    listAllApiKeys({ limit: 500 }),
    listUsers({ limit: 200 }),
  ]);
  const keys = keysResult;
  const userMap = new Map(usersResult.users.map((u) => [u.id, u]));

  return (
    <>
      <Nav username={me.username} role={me.role} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Card>
          <CardHeader
            title="API Keys"
            description={`${keys.length} key${keys.length === 1 ? "" : "s"} total`}
            action={<CreateKeyButton users={usersResult.users} />}
          />
          {keys.length === 0 ? (
            <p className="text-sm text-slate-500">No keys yet.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Owner</TH>
                  <TH>Label</TH>
                  <TH>Prefix</TH>
                  <TH>Quota (used/limit)</TH>
                  <TH>Expires</TH>
                  <TH>Status</TH>
                  <TH>Actions</TH>
                </TR>
              </THead>
              <TBody>
                {keys.map((k) => {
                  const owner = userMap.get(k.userId);
                  return (
                    <TR key={k.id}>
                      <TD>{owner?.username ?? k.userId}</TD>
                      <TD>{k.label}</TD>
                      <TD><code className="text-xs">{k.keyPrefix}</code></TD>
                      <TD>
                        {k.quotaType === "credits"
                          ? `${formatCredits(k.quotaUsed)} / ${formatCredits(k.quotaLimit)} 积分`
                          : `${formatNumber(k.quotaUsed)} / ${formatNumber(k.quotaLimit)}`}
                      </TD>
                      <TD>{formatDate(k.expiresAt)}</TD>
                      <TD>
                        {k.enabled ? <Badge tone="green">enabled</Badge> : <Badge tone="red">disabled</Badge>}
                      </TD>
                      <TD><KeyActions keyId={k.id} enabled={k.enabled} /></TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Card>
      </main>
    </>
  );
}

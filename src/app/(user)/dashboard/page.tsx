import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listApiKeysByUser, getApiKeyById } from "@/lib/db/keys";
import { listUsageByKey, aggregateByUser } from "@/lib/db/usage";
import { Nav } from "@/components/layouts/Nav";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Table, THead, TBody, TR, TH, TD, EmptyState } from "@/components/ui/Table";
import { formatCredits, formatNumber, formatDate } from "@/lib/utils";
import Link from "next/link";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { keys } = await listApiKeysByUser(user.id);
  // Aggregate usage across all user's keys.
  const allLogs = (
    await Promise.all(keys.map((k) => listUsageByKey(k.id, { limit: 50 })))
  ).flat();
  const agg = await aggregateByUser(keys.map((k) => k.id));

  return (
    <>
      <Nav username={user.username} role={user.role} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">My Dashboard</h1>

        <div className="grid gap-4 sm:grid-cols-3 mb-6">
          <Stat label="Active Keys" value={formatNumber(keys.filter((k) => k.enabled).length)} />
          <Stat label="Tokens Used" value={formatNumber(agg.totalTokens)} />
          <Stat label="积分用量" value={formatCredits(agg.creditsUsed)} />
        </div>

        <Card>
          <CardHeader title="API Keys" description="Your personal keys for accessing upstream AI APIs." />
          {keys.length === 0 ? (
            <EmptyState
              title="No keys yet"
              description="Ask an administrator to issue you a key."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Label</TH>
                  <TH>Key</TH>
                  <TH>Quota</TH>
                  <TH>Expires</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {keys.map((k) => (
                  <TR key={k.id}>
                    <TD>{k.label}</TD>
                    <TD>
                      <code className="text-xs">{k.keyPrefix}</code>
                    </TD>
                    <TD>
                        {k.quotaType === "credits"
                        ? `${formatCredits(k.quotaUsed)} / ${formatCredits(k.quotaLimit)} 积分`
                        : `${formatNumber(k.quotaUsed)} / ${formatNumber(k.quotaLimit)} tokens`}
                    </TD>
                    <TD>{formatDate(k.expiresAt)}</TD>
                    <TD>
                      {k.enabled ? <Badge tone="green">enabled</Badge> : <Badge tone="red">disabled</Badge>}
                      {k.expiresAt && new Date(k.expiresAt) < new Date() && (
                        <Badge tone="yellow" className="ml-1">expired</Badge>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card className="mt-6">
          <CardHeader title="Recent Activity" description="Last 50 requests across all your keys." />
          {allLogs.length === 0 ? (
            <EmptyState
              title="No activity yet"
              description="Activity will appear here after you make your first request."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Time</TH>
                  <TH>Model</TH>
                  <TH>Tokens</TH>
                  <TH>积分</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {allLogs.slice(0, 20).map((l) => (
                  <TR key={l.id}>
                    <TD>{formatDate(l.createdAt)}</TD>
                    <TD><code className="text-xs">{l.model}</code></TD>
                    <TD>{formatNumber(l.totalTokens)}</TD>
                    <TD>{formatCredits(l.creditsUsed)}</TD>
                    <TD>
                      {l.status === "success" ? (
                        <Badge tone="green">success</Badge>
                      ) : (
                        <Badge tone="red">error</Badge>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <p className="mt-8 text-xs text-slate-500 text-center">
          Need help? Contact your administrator.
        </p>
      </main>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}

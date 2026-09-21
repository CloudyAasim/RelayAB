import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listProviders } from "@/lib/db/providers";
import { Nav } from "@/components/layouts/Nav";
import { Card, CardHeader } from "@/components/ui/Card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { CreateProviderButton } from "./CreateProviderButton";
import { formatDate } from "@/lib/utils";

export default async function AdminProvidersPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/dashboard");

  const providers = await listProviders();

  return (
    <>
      <Nav username={me.username} role={me.role} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Card>
          <CardHeader
            title="Upstream Providers"
            description="Encrypted API keys are stored in the database; only decrypted at request time."
            action={<CreateProviderButton />}
          />
          {providers.length === 0 ? (
            <p className="text-sm text-slate-500">
              No providers yet. Add one to start serving requests.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Kind</TH>
                  <TH>Base URL</TH>
                  <TH>Models</TH>
                  <TH>Priority</TH>
                  <TH>Created</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {providers.map((p) => (
                  <TR key={p.id}>
                    <TD>{p.name}</TD>
                    <TD><Badge tone="slate">{p.kind}</Badge></TD>
                    <TD>
                      {p.baseUrl ? (
                        <code className="text-xs">{p.baseUrl}</code>
                      ) : (
                        <span className="text-slate-400">default</span>
                      )}
                    </TD>
                    <TD className="text-xs">
                      {Object.entries(p.modelMapping)
                        .map(([k, v]) => `${k}→${v}`)
                        .join(", ") || "—"}
                    </TD>
                    <TD>{p.priority}</TD>
                    <TD>{formatDate(p.createdAt)}</TD>
                    <TD>
                      {p.enabled ? <Badge tone="green">enabled</Badge> : <Badge tone="red">disabled</Badge>}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </main>
    </>
  );
}

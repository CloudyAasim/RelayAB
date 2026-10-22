"use client";

/**
 * src/app/(admin)/admin/settings/DocsSiteForm.tsx
 *
 * The site's own copy, and whether the public docs publish the catalogue.
 *
 * Its own form and its own save, sending only these five keys. It used to share
 * a button with the custom pages and the model notes, so saving a corrected
 * support contact also rewrote both of those from whatever the form was
 * holding.
 */
import { useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SwitchField } from "@/components/ui/Switch";
import { useT } from "@/components/i18n/I18nProvider";
import { useSettingsSave } from "@/components/admin/useSettingsSave";

export interface SiteDocsValues {
  siteName?: string;
  siteDescription?: string;
  announcement?: string;
  supportContact?: string;
  publicCatalog?: boolean;
}

/** The request body for this form, and nothing else. */
export function docsSitePayload(v: SiteDocsValues): Record<string, unknown> {
  return {
    siteName: v.siteName ?? "",
    siteDescription: v.siteDescription ?? "",
    announcement: v.announcement ?? "",
    supportContact: v.supportContact ?? "",
    publicCatalog: v.publicCatalog ?? false,
  };
}

export function DocsSiteForm({ initial }: { initial: SiteDocsValues }) {
  const t = useT();
  const { save, busy, message } = useSettingsSave();
  const [siteName, setSiteName] = useState(initial.siteName ?? "");
  const [siteDescription, setSiteDescription] = useState(initial.siteDescription ?? "");
  const [announcement, setAnnouncement] = useState(initial.announcement ?? "");
  const [supportContact, setSupportContact] = useState(initial.supportContact ?? "");
  const [publicCatalog, setPublicCatalog] = useState(initial.publicCatalog ?? false);

  return (
    <Card>
      <CardHeader title={t("admin.docsSettings.siteTitle")} description={t("admin.docsSettings.siteDesc")} />
      <div className="space-y-4">
        <Input
          label={t("admin.docsSettings.siteName")}
          hint={t("admin.docsSettings.siteNameHint")}
          value={siteName}
          onChange={(e) => setSiteName(e.target.value)}
        />
        <Input
          label={t("admin.docsSettings.siteDescription")}
          value={siteDescription}
          onChange={(e) => setSiteDescription(e.target.value)}
        />
        <div className="space-y-1.5">
          <label htmlFor="docs-announcement" className="block text-sm font-medium text-foreground">
            {t("admin.docsSettings.announcement")}
          </label>
          <textarea
            id="docs-announcement"
            rows={4}
            value={announcement}
            onChange={(e) => setAnnouncement(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        <Input
          label={t("admin.docsSettings.supportContact")}
          hint={t("admin.docsSettings.supportContactHint")}
          value={supportContact}
          onChange={(e) => setSupportContact(e.target.value)}
        />
        {/*
          The one setting on this page that is a yes/no about the whole site,
          so it gets the switch treatment: a row with a name, a sentence that
          says what turning it on actually publishes, and the control on the
          right. It used to be a checkbox under a text input, where it read as
          one more field to fill in.
        */}
        <SwitchField
          id="docs-public-catalog"
          label={t("admin.docsSettings.publicCatalog")}
          description={t("admin.docsSettings.publicCatalogHint")}
          checked={publicCatalog}
          onCheckedChange={setPublicCatalog}
        />
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button
          onClick={() =>
            save(
              docsSitePayload({
                siteName,
                siteDescription,
                announcement,
                supportContact,
                publicCatalog,
              }),
            )
          }
          disabled={busy}
        >
          {busy ? t("admin.docsSettings.saving") : t("admin.docsSettings.save")}
        </Button>
        {message && (
          <span className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>
            {message.text}
          </span>
        )}
      </div>
    </Card>
  );
}

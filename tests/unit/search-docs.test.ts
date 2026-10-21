/**
 * tests/unit/search-docs.test.ts
 *
 * The search service model is the part of this gateway that changed the most in
 * one go: a deployment can offer several search services, the caller names
 * one, and **there is no default**. That is a contract a client has to be able
 * to read somewhere, and an operator has to be able to act on.
 *
 * So the two audiences each get it written down, in their own language:
 *
 *   - the **user** documentation: the catalogue (`GET /v1/search/services`),
 *     the `service` field, that nobody is searched with unless somebody says
 *     which one, and the rule that bites them if they point the assistant at
 *     a service on their own private network;
 *   - the **admin** documentation: the client-visible name, the absence of a
 *     default, and the two refusals they will meet (nobody named a service, or
 *     the named one cannot answer).
 *
 * A guard like this exists because documentation drifts: the code moved to
 * "no default" in one commit, and the prose still said "the active one" in
 * three places — which is a worse answer than no answer, because it is a
 * confident one.
 */
import { describe, it, expect } from "vitest";
import { DICTS } from "@/lib/i18n/dict";

/** The strings the two documentation surfaces actually render. */
function userDoc(locale: "zh-CN" | "en"): string {
  return [
    DICTS[locale]["docs.search.desc"],
    DICTS[locale]["docs.search.requestHint"],
    DICTS[locale]["docs.search.serviceHint"],
    DICTS[locale]["docs.search.servicesTitle"],
    DICTS[locale]["docs.search.servicesDesc"],
    DICTS[locale]["docs.search.servicesHint"],
    DICTS[locale]["docs.search.assistant"],
    DICTS[locale]["docs.search.ownServiceNote"],
  ].join("\n");
}

function adminDoc(locale: "zh-CN" | "en"): string {
  return [
    DICTS[locale]["admin.docs.search.desc"],
    DICTS[locale]["admin.docs.search.arch"],
    DICTS[locale]["admin.docs.search.config"],
    DICTS[locale]["admin.docs.search.panel"],
    DICTS[locale]["admin.docs.search.security"],
    DICTS[locale]["admin.docs.search.assistant"],
    DICTS[locale]["admin.docs.search.trouble"],
  ].join("\n");
}

describe("the user documentation explains how to choose a search service", () => {
  it("names the catalogue and the field that picks one", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      const doc = userDoc(locale);
      expect(doc, `${locale}: no catalogue endpoint`).toContain("/v1/search/services");
      expect(doc, `${locale}: no mention of the field that names one`).toContain("service");
    }
  });

  it("says that nobody is searched with unless somebody says which", () => {
    // The Chinese wording and the English wording are different sentences, so
    // each is checked for its own words rather than for a shared keyword.
    expect(userDoc("zh-CN")).toContain("没有默认");
    expect(userDoc("en")).toMatch(/no default/i);
  });

  it("says that the user's own service has to be publicly reachable", () => {
    // The rule that protects the deployment's inside, written where the user
    // reads about pointing the assistant at their own service.
    expect(userDoc("zh-CN")).toContain("公网");
    expect(userDoc("en")).toMatch(/public internet/i);
  });
});

describe("the admin documentation explains how to run several services", () => {
  it("names the client-visible name and says there is no default", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      const doc = adminDoc(locale);
      expect(doc, `${locale}: the client-visible name is not documented`).toMatch(
        /客户端可见名称|client-visible name/i,
      );
    }
    expect(adminDoc("zh-CN")).toContain("没有默认");
    expect(adminDoc("en")).toMatch(/no default/i);
  });

  it("names the two refusals an operator will meet", () => {
    // "Several services and nobody named one" and "the named one cannot
    // answer" are the two ways this design refuses, and both are things an
    // operator will be shown in a test and have to recognise.
    expect(adminDoc("zh-CN")).toMatch(/多个搜索服务/);
    expect(adminDoc("zh-CN")).toMatch(/不会悄悄换成别的服务/);
    expect(adminDoc("en")).toMatch(/several search services/i);
    expect(adminDoc("en")).toMatch(/no other service is quietly used instead/i);
  });

  it("says that a user's own service address has to be public", () => {
    expect(adminDoc("zh-CN")).toMatch(/用户自己填的搜索服务地址/);
    expect(adminDoc("en")).toMatch(/A search service a user configures/);
  });
});

describe("neither document still promises an 'active' provider", () => {
  it("the wording that survived the change is the wording that is wrong", () => {
    // "The provider that is currently serving" was true when there was one
    // provider and a priority order. It is not true now: nobody is served
    // without being named, and a deployment can have several.
    for (const locale of ["zh-CN", "en"] as const) {
      expect(adminDoc(locale), `${locale}: still talks about the serving provider`).not.toMatch(
        /当前生效的提供商|the provider that is currently serving/i,
      );
      expect(userDoc(locale), `${locale}: still talks about the serving provider`).not.toMatch(
        /当前生效的搜索提供商|the provider that serves it/i,
      );
    }
  });
});

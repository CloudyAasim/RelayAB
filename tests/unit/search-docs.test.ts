/**
 * tests/unit/search-docs.test.ts
 *
 * The search service model, in the two documents a client and an operator read.
 *
 * **The contract changed once, and this file changed with it.**
 *
 * It used to be: a deployment can offer several search services, the caller
 * names one, and **there is no default**. That was true, it was written down
 * in both languages, and this file existed to keep the prose from drifting
 * back into "the one that is currently serving".
 *
 * It is now: the caller still names a service when it wants a particular one,
 * and **the operator marks a default** for the requests that name none. The
 * reason is a client that speaks the other search APIs — there is no field in
 * those requests for "which engine", so a deployment with more than one
 * service has to say which one answers on its own.
 *
 * The rule that survived the change, and is the one that matters most, is
 * unchanged: **nothing is quietly substituted**. A default that cannot be
 * honoured is refused **by name**, because these rows carry their own prices
 * and serving a different one would change what the account is charged.
 *
 * The trap this file is still here for is the one it was written for: a
 * document can say "there is no default" in one paragraph and "leave it out
 * and the default answers" in the next, and a reader takes whichever one they
 * read second. The two statements cannot both be in the same document.
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

  it("says that an unnamed request is answered by the marked default", () => {
    // The Chinese wording and the English wording are different sentences, so
    // each is checked for its own words rather than for a shared keyword.
    expect(userDoc("zh-CN")).toContain("默认");
    expect(userDoc("en")).toMatch(/default/i);
    // And that the default is a **visible** one: the row carries a badge.
    expect(userDoc("zh-CN")).toContain("「默认」");
    expect(userDoc("en")).toContain('"default"');
  });

  it("says that the user's own service has to be publicly reachable", () => {
    // The rule that protects the deployment's inside, written where the user
    // reads about pointing the assistant at their own service.
    expect(userDoc("zh-CN")).toContain("公网");
    expect(userDoc("en")).toMatch(/public internet/i);
  });
});

describe("the admin documentation explains how to run several services", () => {
  it("names the client-visible name and the marked default", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      const doc = adminDoc(locale);
      expect(doc, `${locale}: the client-visible name is not documented`).toMatch(
        /客户端可见名称|client-visible name/i,
      );
    }
    // The default is the operator's to mark, and the panel says so.
    expect(adminDoc("zh-CN")).toContain("默认");
    expect(adminDoc("en")).toMatch(/default/i);
    expect(adminDoc("zh-CN")).toContain("设为默认");
    expect(adminDoc("en")).toMatch(/set as default/i);
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

  it("says that a default that cannot be honoured is refused by name", () => {
    // The half of the new contract that is not a convenience: the default is
    // a choice, and a choice that cannot be kept is a refusal, not a
    // substitution.
    expect(adminDoc("zh-CN")).toMatch(/被指定为默认的那一行不能用/);
    expect(adminDoc("en")).toMatch(/marked as the default cannot answer/i);
  });

  it("says that a user's own service address has to be public", () => {
    expect(adminDoc("zh-CN")).toMatch(/用户自己填的搜索服务地址/);
    expect(adminDoc("en")).toMatch(/A search service a user configures/);
  });
});

describe("neither document still promises an 'active' provider", () => {
  it("the wording that survived the change is the wording that is wrong", () => {
    // "The provider that is currently serving" was true when there was one
    // provider and a priority order. It is not true now: a deployment can have
    // several, and which one answers is a choice somebody made.
    for (const locale of ["zh-CN", "en"] as const) {
      expect(adminDoc(locale), `${locale}: still talks about the serving provider`).not.toMatch(
        /当前生效的提供商|the provider that is currently serving/i,
      );
      expect(userDoc(locale), `${locale}: still talks about the serving provider`).not.toMatch(
        /当前生效的搜索提供商|the provider that serves it/i,
      );
    }
  });

  it("and neither still denies that there is a default", () => {
    // This one is the trap: a document can say "there is no default" in one
    // paragraph and "leave it out and the default answers" in the next, and a
    // reader takes whichever one they read second. The two statements cannot
    // both be in the same document.
    //
    // The patterns are the old sentences, not the bare words: "没有默认" on
    // its own is also how the new text says "no default was marked, so the
    // request is refused", which is a different sentence entirely.
    for (const locale of ["zh-CN", "en"] as const) {
      expect(userDoc(locale), `${locale}: still denies a default`).not.toMatch(
        /没有默认的那一个|没有默认服务|这里没有默认|no default one|there is no default/i,
      );
      expect(adminDoc(locale), `${locale}: still denies a default`).not.toMatch(
        /没有默认的那一个|没有默认服务|这里没有「设为默认」|no default one|there is no default/i,
      );
    }
  });
});

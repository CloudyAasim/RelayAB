/**
 * The configuration mistakes that actually happened, so the checks below are
 * grounded rather than invented:
 *
 *  - five models sat at `inputCost: 0, outputCost: 0` while enabled, billing
 *    nothing at all, and nothing in the system said so;
 *  - one model's rates were `2.1 / 8.4` — yuan per million — sitting in the
 *    same table as `210 / 840`, which is the same number in credits. A hundred
 *    times off, and it looked like a plausible rate;
 *  - several models had `cachedInputCost` set and `cacheWriteCost` absent, so a
 *    write fell back to the input price rather than to the free rate the vendor
 *    actually charges.
 *
 * None of these is a schema error. Every one parses. The value was accepted,
 * stored, and billed, and the only thing that would have caught them is a
 * question asked before the write.
 */

export type Finding = {
  /** Stable-ish key, so a caller can tell the same finding from another. */
  code: "all_zero" | "unit_mismatch" | "cache_write_unset" | "write_gt_input";
  clientId: string;
  message: string;
  /** True when writing this would probably be a mistake. */
  blocking: boolean;
};

/** A rate is in yuan rather than credits if it is small and another is not. */
const CREDITS_FLOOR = 20; // 0.2 元/百万 token

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

type Row = Record<string, unknown>;

/**
 * What is wrong with one set of model configurations.
 *
 * Takes the state **after** the proposed write, not before, so it judges the
 * outcome rather than the intention.
 */
export function auditModelConfigs(configs: Record<string, Row>): Finding[] {
  const out: Finding[] = [];
  const rows = Object.entries(configs);
  const rates = rows
    .map(([id, c]) => [id, c.inputCost, c.outputCost] as const)
    .filter(([, i, o]) => isNumber(i) || isNumber(o));

  // Anything already in credits, used to judge the ones that are not.
  const inCredits = rates.filter(([, i]) => isNumber(i) && (i as number) >= CREDITS_FLOOR);

  for (const [clientId, cfg] of rows) {
    const input = cfg.inputCost;
    const output = cfg.outputCost;

    if (
      cfg.enabled !== false &&
      isNumber(input) &&
      isNumber(output) &&
      input === 0 &&
      output === 0
    ) {
      out.push({
        code: "all_zero",
        clientId,
        message:
          `输入和输出都是 0，这个模型会完全不计费。` +
          `如果它确实免费请确认；否则这是价格没填。`,
        blocking: true,
      });
    }

    // 2.1 next to 210 is yuan next to credits, not a cheap model.
    if (
      inCredits.length > 0 &&
      isNumber(input) &&
      input > 0 &&
      input < CREDITS_FLOOR
    ) {
      out.push({
        code: "unit_mismatch",
        clientId,
        message:
          `输入价 ${input} 与同一服务商里其它模型的 ${inCredits[0][1]} 量级差约 100 倍——` +
          `1 元 = 100 积分，本系统的价格单位是「每 100 万 token 的积分」。` +
          `确认这是积分不是元。`,
        blocking: true,
      });
    }

    // A cache read price with no write price silently bills writes at the input
    // rate. Free and unset are different, and only one of them is a discount.
    if (
      isNumber(cfg.cachedInputCost) &&
      cfg.cachedInputCost < (isNumber(input) ? (input as number) : 0) &&
      cfg.cacheWriteCost === undefined
    ) {
      out.push({
        code: "cache_write_unset",
        clientId,
        message:
          `缓存读取价 ${cfg.cachedInputCost} 但缓存写入价没填——写入会回落到按输入价 ` +
          `${input} 计费。如果这个模型的缓存写入是免费的，请显式填 0：留空和 0 不是一回事。`,
        blocking: false,
      });
    }

    if (
      isNumber(cfg.cacheWriteCost) &&
      isNumber(input) &&
      (cfg.cacheWriteCost as number) > (input as number) * 3 &&
      (cfg.cacheWriteCost as number) > 0
    ) {
      out.push({
        code: "write_gt_input",
        clientId,
        message: `缓存写入价 ${cfg.cacheWriteCost} 是输入价 ${input} 的三倍以上，请确认没有串行。`,
        blocking: false,
      });
    }
  }

  return out;
}

/** The one-line form, for a tool result or a proposal's warnings. */
export function describeFindings(findings: Finding[]): string[] {
  return findings.map((f) => `[${f.code}] ${f.clientId}：${f.message}`);
}

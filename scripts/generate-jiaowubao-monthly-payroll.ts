import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { generateMonthlyPayroll } from "../lib/payroll/monthly-service";
import { createMonthlyPayrollWorkbook } from "../lib/payroll/monthly-workbook";

const DEFAULT_OUTPUT = "jiaowubao-monthly-hours-complete.xlsx";

function usage() {
  return [
    "Usage: npm run generate:jiaowubao-monthly-payroll -- [YYYY-MM]",
    "",
    "Requires server-side JIAOWUBAO_GATEWAY_SK.",
    "JIAOWUBAO_TRIAL_MEMBER_IDS is either exactly three confirmed B-account IDs",
    "or intentionally blank to keep every lesson classified as 待分类.",
  ].join("\n");
}

async function main() {
  const arguments_ = process.argv.slice(2).filter(Boolean);
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    process.stdout.write(usage() + "\n");
    return;
  }
  if (arguments_.length > 1) {
    throw new Error(usage());
  }

  const period = arguments_[0]?.trim() || process.env.JIAOWUBAO_MONTHLY_PAYROLL_PERIOD?.trim() || undefined;
  const output = resolve(process.cwd(), DEFAULT_OUTPUT);
  const sync = await generateMonthlyPayroll(period);
  const workbook = await createMonthlyPayrollWorkbook(sync.report);
  await writeFile(output, workbook);

  // Deliberately log only operational metadata: neither the gateway credential
  // nor student names/attendance are emitted into GitHub Actions logs.
  process.stdout.write(JSON.stringify({
    period: sync.report.period.value,
    pages: sync.pages,
    sourceRows: sync.report.summary.sourceRows,
    uniqueLessons: sync.report.summary.uniqueLessons,
    output: DEFAULT_OUTPUT,
  }) + "\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "月度课时表生成失败。";
  process.stderr.write(message + "\n");
  process.exitCode = 1;
});

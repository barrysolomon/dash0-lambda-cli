/** ASCII banner shown when the menu launches. Kept compact + 80-col safe. */

import kleur from "kleur";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

export function renderBanner(): string {
  const lines = [
    "",
    kleur.cyan("  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓"),
    kleur.cyan("  ┃") +
      kleur.bold().white("              dash0-lambda · interactive menu                ") +
      kleur.cyan("┃"),
    kleur.cyan("  ┃") +
      kleur.dim("       Manage the Dash0 Lambda extension on AWS              ") +
      kleur.cyan("┃"),
    kleur.cyan("  ┃") +
      kleur.dim("                  (unofficial · personal tool)               ") +
      kleur.cyan("┃"),
    kleur.cyan("  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"),
  ];
  return lines.join("\n");
}

export interface AwsIdentity {
  account?: string;
  arn?: string;
  userId?: string;
  region?: string;
}

/** Best-effort identity lookup. Never throws. */
export async function probeIdentity(
  region: string | undefined,
): Promise<AwsIdentity> {
  if (!region) return { region };
  try {
    const sts = new STSClient({ region, maxAttempts: 1 });
    const out = await sts.send(new GetCallerIdentityCommand({}));
    return {
      account: out.Account,
      arn: out.Arn,
      userId: out.UserId,
      region,
    };
  } catch {
    return { region };
  }
}

export function renderIdentity(id: AwsIdentity): string {
  if (!id.account) {
    return kleur.dim(
      `  AWS: ${kleur.yellow("not detected")}${id.region ? ` · region ${id.region}` : ""}` +
        " — set AWS_PROFILE or AWS_REGION before continuing",
    );
  }
  const arnTail = id.arn?.split("/").slice(-1)[0] ?? "?";
  return kleur.dim(
    `  AWS: account ${kleur.bold(id.account)} as ${arnTail}` +
      (id.region ? ` · region ${kleur.bold(id.region)}` : ""),
  );
}

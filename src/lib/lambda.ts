/**
 * Thin wrapper around @aws-sdk/client-lambda that we can mock easily and
 * that supports a `dryRun` mode (no mutating calls).
 */

import {
  LambdaClient,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  ListFunctionsCommand,
  ListLayerVersionsCommand,
  ListTagsCommand,
  UpdateFunctionConfigurationCommand,
  type FunctionConfiguration,
  type Layer,
} from "@aws-sdk/client-lambda";

export interface LambdaWrapperOptions {
  region: string;
  dryRun?: boolean;
  /** Inject a client (for tests). */
  client?: LambdaClient;
}

export interface FunctionSnapshot {
  functionName: string;
  functionArn: string;
  runtime: string;
  architectures: string[];
  layers: Layer[];
  env: Record<string, string>;
  role: string;
  lastModified?: string;
  /**
   * "Zip" (zip archive deployment) or "Image" (container-image deployment).
   * Image functions can't have layers attached, so install / update-layer /
   * uninstall / migrate are all no-ops on them. Surfaced so callers can
   * filter or warn.
   */
  packageType: "Zip" | "Image";
  /**
   * Resource tags. Populated lazily by callers that need them (the list
   * API doesn't return tags — it takes a separate `ListTags` call per
   * ARN). Absent when not yet fetched; empty object when fetched and
   * the function has no tags.
   */
  tags?: Record<string, string>;
  raw: FunctionConfiguration;
}

export class LambdaWrapper {
  readonly region: string;
  readonly dryRun: boolean;
  private readonly client: LambdaClient;

  constructor(opts: LambdaWrapperOptions) {
    this.region = opts.region;
    this.dryRun = opts.dryRun ?? false;
    this.client =
      opts.client ?? new LambdaClient({ region: opts.region, maxAttempts: 5 });
  }

  async getFunction(name: string): Promise<FunctionSnapshot> {
    const out = await this.client.send(
      new GetFunctionConfigurationCommand({ FunctionName: name }),
    );
    return toSnapshot(out);
  }

  async *listFunctions(): AsyncGenerator<FunctionSnapshot> {
    let marker: string | undefined;
    do {
      const out = await this.client.send(
        new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }),
      );
      for (const fn of out.Functions ?? []) {
        yield toSnapshot(fn);
      }
      marker = out.NextMarker;
    } while (marker);
  }

  /** Returns the latest published version for a layer in this region. */
  async latestLayerVersion(
    layerName: string,
    ownerAccount: string,
  ): Promise<number> {
    // Layer ARN includes the owner account; the API call must be scoped by it.
    const layerArn = `arn:aws:lambda:${this.region}:${ownerAccount}:layer:${layerName}`;
    const out = await this.client.send(
      new ListLayerVersionsCommand({ LayerName: layerArn, MaxItems: 1 }),
    );
    const version = out.LayerVersions?.[0]?.Version;
    if (!version) {
      throw new Error(
        `No published versions found for layer ${layerArn}. ` +
          `Either the layer name is wrong or the publishing account ` +
          `(${ownerAccount}) hasn't granted you GetLayerVersion permission ` +
          `in region ${this.region}.`,
      );
    }
    return version;
  }

  async updateFunctionConfig(args: {
    name: string;
    layerArns: string[];
    env: Record<string, string>;
    revisionId?: string;
  }): Promise<{ applied: boolean; reason?: string }> {
    if (this.dryRun) {
      return { applied: false, reason: "dry-run" };
    }
    await this.client.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: args.name,
        Layers: args.layerArns,
        Environment: { Variables: args.env },
        RevisionId: args.revisionId,
      }),
    );
    return { applied: true };
  }

  /** Direct passthrough for callers that need package-level details. */
  async getFunctionFull(name: string) {
    return this.client.send(new GetFunctionCommand({ FunctionName: name }));
  }

  /** Resource tags for a function (keyed by full ARN). */
  async listTags(arn: string): Promise<Record<string, string>> {
    const out = await this.client.send(new ListTagsCommand({ Resource: arn }));
    return out.Tags ?? {};
  }
}

function toSnapshot(fn: FunctionConfiguration): FunctionSnapshot {
  // PackageType is "Zip" by default for older zip-deployed functions where
  // the field may be absent — only Image functions reliably set it.
  const packageType: "Zip" | "Image" =
    fn.PackageType === "Image" ? "Image" : "Zip";
  return {
    functionName: fn.FunctionName ?? "",
    functionArn: fn.FunctionArn ?? "",
    runtime: fn.Runtime ?? "unknown",
    architectures: fn.Architectures ?? ["x86_64"],
    layers: fn.Layers ?? [],
    env: fn.Environment?.Variables ?? {},
    role: fn.Role ?? "",
    lastModified: fn.LastModified,
    packageType,
    raw: fn,
  };
}

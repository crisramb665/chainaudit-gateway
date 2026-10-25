import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import type {
  CreateTargetResult,
  TargetStatus,
  TenantRegistry,
  TenantTarget,
} from '../../core/ports/tenant-registry.ts'

export interface DynamoDbTenantRegistryOptions {
  tableName: string
  region: string
  /** Set for DynamoDB Local; omitted in AWS. Switching is configuration only. */
  endpoint?: string
}

// LEARN: Single-table design keyed by tenant. Every item of a tenant lives in
// the partition PK = TENANT#<id>: its CONFIG item and one TARGET#<id> item per
// target. Every read names the tenant in the key (GetItem or Query on the PK),
// so there is no code path that lists across tenants, and in AWS an IAM
// condition on dynamodb:LeadingKeys can pin a tenant-tagged role to its own
// partition. Scans are never used: they read every tenant's data.
const tenantKey = (tenantId: string) => `TENANT#${tenantId}`
const targetKey = (targetId: string) => `TARGET#${targetId}`
const CONFIG_KEY = 'CONFIG'

interface TargetItem {
  PK: string
  SK: string
  target_id: string
  name: string
  base_url: string
  auth_type: 'api_key'
  secret_ref: string
  status: TargetStatus
  status_reason?: string
  version: number
  created_at: string
}

/** TenantRegistry on DynamoDB (Local or AWS). */
export class DynamoDbTenantRegistry implements TenantRegistry {
  private readonly db: DynamoDBDocumentClient
  private readonly table: string

  constructor(options: DynamoDbTenantRegistryOptions) {
    this.table = options.tableName
    // The SDK client is this adapter's implementation. Explicit timeouts and a
    // small retry budget: the SDK default would retry 3 times with no request timeout.
    const client = new DynamoDBClient({
      region: options.region,
      // DynamoDB Local accepts any credentials; in AWS the default provider chain (the Lambda role) is used.
      ...(options.endpoint
        ? { endpoint: options.endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
        : {}),
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 },
    })
    this.db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } })
  }

  async listActiveTargets(tenantId: string): Promise<TenantTarget[]> {
    const items: TargetItem[] = []
    let startKey: Record<string, unknown> | undefined
    do {
      const page = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': tenantKey(tenantId), ':prefix': 'TARGET#' },
          ExclusiveStartKey: startKey,
        }),
      )
      items.push(...((page.Items ?? []) as TargetItem[]))
      startKey = page.LastEvaluatedKey
    } while (startKey)
    return items.filter((item) => item.status === 'active').map((item) => toTarget(tenantId, item))
  }

  async getTarget(tenantId: string, targetId: string): Promise<TenantTarget | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: tenantKey(tenantId), SK: targetKey(targetId) } }),
    )
    return Item ? toTarget(tenantId, Item as TargetItem) : undefined
  }

  async createTarget(target: TenantTarget): Promise<CreateTargetResult> {
    const item: TargetItem = {
      PK: tenantKey(target.tenantId),
      SK: targetKey(target.targetId),
      target_id: target.targetId,
      name: target.name,
      base_url: target.baseUrl,
      auth_type: target.authType,
      secret_ref: target.secretRef,
      status: target.status,
      ...(target.statusReason ? { status_reason: target.statusReason } : {}),
      version: target.version,
      created_at: target.createdAt,
    }
    try {
      // LEARN: Quota and idempotency in one atomic step. Counting targets with
      // a Query and then writing races: two concurrent registrations both see
      // 2 of 3 and both write. The transaction increments the tenant's counter
      // only while it is below max_targets AND puts the target only if its key
      // does not exist yet; either condition failing cancels both writes.
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: { PK: item.PK, SK: CONFIG_KEY },
                UpdateExpression: 'SET target_count = if_not_exists(target_count, :zero) + :one',
                ConditionExpression:
                  'attribute_exists(PK) AND (attribute_not_exists(target_count) OR target_count < max_targets)',
                ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: item,
                // Same PK and SK already present: registering twice is a no-op.
                ConditionExpression: 'attribute_not_exists(SK)',
              },
            },
          ],
        }),
      )
      return 'created'
    } catch (err) {
      if (!(err instanceof TransactionCanceledException)) throw err
      const [configReason, targetReason] = err.CancellationReasons ?? []
      // A duplicate is reported first: re-registering at the quota limit is still idempotent.
      if (targetReason?.Code === 'ConditionalCheckFailed') return 'duplicate'
      if (configReason?.Code === 'ConditionalCheckFailed') {
        return (await this.tenantExists(target.tenantId)) ? 'quota_exceeded' : 'unknown_tenant'
      }
      throw err
    }
  }

  async updateTargetStatus(
    tenantId: string,
    targetId: string,
    expectedVersion: number,
    status: TargetStatus,
    reason: string | undefined,
  ): Promise<TenantTarget | 'version_conflict'> {
    try {
      const { Attributes } = await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: tenantKey(tenantId), SK: targetKey(targetId) },
          UpdateExpression: reason
            ? 'SET #status = :status, status_reason = :reason, version = version + :one'
            : 'SET #status = :status, version = version + :one REMOVE status_reason',
          // Optimistic concurrency: only if nobody changed the item since we read it.
          ConditionExpression: 'version = :expected',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': status,
            ':expected': expectedVersion,
            ':one': 1,
            ...(reason ? { ':reason': reason } : {}),
          },
          ReturnValues: 'ALL_NEW',
        }),
      )
      return toTarget(tenantId, Attributes as TargetItem)
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return 'version_conflict'
      throw err
    }
  }

  private async tenantExists(tenantId: string): Promise<boolean> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { PK: tenantKey(tenantId), SK: CONFIG_KEY } }),
    )
    return Item !== undefined
  }
}

function toTarget(tenantId: string, item: TargetItem): TenantTarget {
  return {
    tenantId,
    targetId: item.target_id,
    name: item.name,
    baseUrl: item.base_url,
    authType: item.auth_type,
    secretRef: item.secret_ref,
    status: item.status,
    ...(item.status_reason ? { statusReason: item.status_reason } : {}),
    version: item.version,
    createdAt: item.created_at,
  }
}

// Creates the tenant registry table in DynamoDB Local and onboards the two
// sample tenants (their CONFIG items). DynamoDB Local runs in memory, so run
// this after every `pnpm infra:up`. Safe to run twice.
// A script is its own tiny composition root: it reads and validates its env here, once.
import { CreateTableCommand, DynamoDBClient, ResourceInUseException } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import { z } from 'zod'

const env = z
  .object({
    DYNAMODB_ENDPOINT: z.url().default('http://localhost:8000'),
    AWS_REGION: z.string().default('us-east-1'),
    REGISTRY_TABLE: z.string().default('chainaudit-registry'),
  })
  .parse(process.env)

const client = new DynamoDBClient({
  region: env.AWS_REGION,
  endpoint: env.DYNAMODB_ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 1000, requestTimeout: 5000 },
})
const db = DynamoDBDocumentClient.from(client)

try {
  await client.send(
    new CreateTableCommand({
      TableName: env.REGISTRY_TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      // Single table: PK = TENANT#<id>, SK = CONFIG | TARGET#<id>. No indexes needed.
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    }),
  )
  console.log(`table ${env.REGISTRY_TABLE} created`)
} catch (err) {
  if (!(err instanceof ResourceInUseException)) throw err
  console.log(`table ${env.REGISTRY_TABLE} already exists`)
}

const tenants = [
  { tenant_id: 'acme', max_targets: 3, allowed_domains: ['localhost', '127.0.0.1'] },
  { tenant_id: 'globex', max_targets: 1, allowed_domains: ['localhost', '127.0.0.1'] },
]
for (const tenant of tenants) {
  // Only creates CONFIG if missing, so re-running never resets target_count.
  await db
    .send(
      new PutCommand({
        TableName: env.REGISTRY_TABLE,
        Item: {
          PK: `TENANT#${tenant.tenant_id}`,
          SK: 'CONFIG',
          max_targets: tenant.max_targets,
          allowed_domains: tenant.allowed_domains,
          target_count: 0,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    )
    .then(
      () => console.log(`CONFIG for ${tenant.tenant_id}: max_targets ${tenant.max_targets}`),
      (err: unknown) => {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err
        console.log(`CONFIG for ${tenant.tenant_id} already exists`)
      },
    )
}

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CredentialAccessDeniedError } from '../../core/errors.ts'
import { tenantOfSecretRef } from '../../core/registry/secret-ref.ts'
import type { CredentialProvider } from '../../core/ports/credential-provider.ts'
import type { Principal } from '../../core/ports/token-verifier.ts'

/**
 * Local stand-in for Secrets Manager: one file per secret under
 * `<dir>/tenants/<tenant>/targets/<target>`, readable by the owner only.
 */
export class FileCredentialProvider implements CredentialProvider {
  private readonly dir: string

  constructor(options: { dir: string }) {
    this.dir = options.dir
  }

  async getSecret(caller: Principal, secretRef: string): Promise<string> {
    return (await readFile(this.pathFor(caller, secretRef), 'utf8')).trim()
  }

  async putSecret(caller: Principal, secretRef: string, value: string): Promise<void> {
    const path = this.pathFor(caller, secretRef)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, value, { mode: 0o600 })
  }

  // LEARN: This is the tenant check that, in AWS, IAM performs instead. There
  // the shared Lambda assumes a role through STS with the session tag
  // tenant_id=<caller's tenant>, and the role policy only allows
  // secretsmanager:GetSecretValue on secrets whose tenant_id tag equals
  // ${aws:PrincipalTag/tenant_id} (ABAC). This code-level check is weaker: it
  // runs inside the very process it is meant to protect, so a bug, a new code
  // path that reads files directly, or a compromised dependency can skip it.
  // IAM is evaluated by AWS, outside our code, so even a wrong tenant id in
  // our code cannot read another tenant's secret.
  private pathFor(caller: Principal, secretRef: string): string {
    const owner = tenantOfSecretRef(secretRef)
    if (owner === undefined || owner !== caller.tenantId) throw new CredentialAccessDeniedError()
    // The ref was validated against a strict slug pattern, so it cannot escape `dir`.
    return join(this.dir, secretRef)
  }
}

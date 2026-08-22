import { z } from 'zod'

/**
 * Zod-validated process environment, per grill-result §5.7.
 *
 * Reading `env` for the first time validates the whole environment and throws with every
 * offending variable named. `assertEnvOrExit()` turns that into a non-zero process exit and is
 * called from scripts/check-env.ts, which runs before Next.js binds a port.
 */

const SECRET_MIN_BYTES = 32

const secretAtLeast32Bytes = (variableName: string) =>
  z.string().refine((value) => Buffer.byteLength(value, 'utf8') >= SECRET_MIN_BYTES, {
    message: `${variableName} must be at least ${SECRET_MIN_BYTES} bytes (got fewer); generate one with \`openssl rand -base64 48\``,
  })

const positiveIntFromString = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue)

const booleanFromString = (defaultValue: boolean) =>
  z
    .enum(['true', 'false'])
    .default(defaultValue ? 'true' : 'false')
    .transform((value) => value === 'true')

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  APP_URL: z.url(),
  ARTIFACT_ORIGIN_TEMPLATE: z.string().refine((value) => value.includes('{id}'), {
    message: 'ARTIFACT_ORIGIN_TEMPLATE must contain the {id} placeholder',
  }),

  DATABASE_URL: z.string().min(1),

  S3_ENDPOINT: z.url(),
  // Only set when the browser cannot reach S3_ENDPOINT — bundled MinIO on a compose network, or a
  // private VPC endpoint fronted by a public host. Presigned URLs sign their own host, so they are
  // signed with this one. Defaults to S3_ENDPOINT.
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanFromString(true),

  SESSION_SECRET: secretAtLeast32Bytes('SESSION_SECRET'),
  ENCRYPTION_KEY: secretAtLeast32Bytes('ENCRYPTION_KEY'),

  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.url().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  DEFAULT_MODEL: z.string().min(1),

  ALLOW_OPEN_REGISTRATION: booleanFromString(false),

  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),

  RATE_LIMIT_GENERATIONS_PER_HOUR: positiveIntFromString(10),
  RATE_LIMIT_GENERATIONS_PER_HOUR_OWN_KEY: positiveIntFromString(100),
  QUOTA_GENERATIONS_PER_DAY: positiveIntFromString(100),
  QUOTA_GENERATIONS_PER_DAY_OWN_KEY: positiveIntFromString(1000),

  BUNDLE_MAX_FILES: positiveIntFromString(50),
  BUNDLE_MAX_TOTAL_BYTES: positiveIntFromString(10_485_760),
  BUNDLE_MAX_FILE_BYTES: positiveIntFromString(2_097_152),

  PRESIGN_TTL_SECONDS: positiveIntFromString(60),
  HANDOFF_TTL_SECONDS: positiveIntFromString(30),
  ARTIFACT_GRANT_TTL_SECONDS: positiveIntFromString(1800),

  TRASH_RETENTION_DAYS: positiveIntFromString(30),
  AUDIT_RETENTION_DAYS: positiveIntFromString(365),

  RATE_LIMIT_AUTH_PER_IP_PER_HOUR: positiveIntFromString(30),

  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: positiveIntFromString(587),
  SMTP_SECURE: booleanFromString(false),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_FROM: z.string().min(1).optional(),
  PASSWORD_RESET_TTL_SECONDS: positiveIntFromString(3600),
})

export type Env = z.infer<typeof envSchema>

export class EnvValidationError extends Error {
  // A plain field, not a parameter property: scripts/check-env.ts runs this file through
  // Node's strip-only type stripping, which rejects parameter properties.
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Invalid environment:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
    this.name = 'EnvValidationError'
    this.problems = problems
  }
}

/** Exported for tests: validates an arbitrary record instead of `process.env`. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source)
  if (result.success) return result.data

  const problems = result.error.issues.map((issue) => {
    const variableName = issue.path.join('.') || '(root)'
    return `${variableName}: ${issue.message}`
  })
  throw new EnvValidationError(problems)
}

let cachedEnv: Env | undefined

function loadEnv(): Env {
  cachedEnv ??= parseEnv(process.env)
  return cachedEnv
}

/**
 * Proxy rather than an eager parse so that importing this module never crashes a build:
 * `next build` evaluates route modules without a real environment.
 */
export const env: Env = new Proxy({} as Env, {
  get: (_target, property) => loadEnv()[property as keyof Env],
  has: (_target, property) => property in loadEnv(),
  ownKeys: () => Reflect.ownKeys(loadEnv()),
  getOwnPropertyDescriptor: (_target, property) => ({
    value: loadEnv()[property as keyof Env],
    enumerable: true,
    configurable: true,
  }),
})

/** Called from scripts/check-env.ts — before Next.js binds a port. */
export function assertEnvOrExit(): void {
  try {
    loadEnv()
  } catch (error) {
    const message = error instanceof EnvValidationError ? error.message : String(error)
    console.error(`[enclave] refusing to start.\n${message}`)
    process.exit(1)
  }
}
